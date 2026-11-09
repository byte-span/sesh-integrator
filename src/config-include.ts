import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  Config,
  IncludeReport,
  IncludedSettingReport,
  RepositoryConfig,
} from "./types.js";

/** `{{name}}`; anything else between the braces is a malformed placeholder. */
const PLACEHOLDER = /\{\{(.*?)\}\}/g;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Top-level settings an include file may set. Each is taken whole from the
 * last source that sets it: `config.json`, else the last include; values are
 * never merged key by key. An include's `null` removes the value earlier
 * includes set.
 */
export const SHARED_SETTINGS = [
  "lockWaitSeconds",
  "codexCommand",
  "harnessCommands",
  "conflictResolutionMode",
  "defaultTargetBranch",
  "defaultPromotion",
  "deliveryPolicyFile",
  "integrationBatching",
] as const;

/** Keys that describe one machine and so belong only in `config.json`. */
const LOCAL_ONLY = ["include", "disabledRepositories"];

interface LoadedInclude {
  report: IncludeReport;
  /** Registrations with placeholders filled and paths checked. */
  repositories: RepositoryConfig[];
}

interface Candidate {
  /** The registration laid over from the include files, before validation. */
  layered: Record<string, unknown>;
  repository: RepositoryConfig;
  report: IncludeReport;
  exists: boolean;
}

/** Keys a registration needs once every include has been laid over it. */
const REQUIRED_REGISTRATION_KEYS = [
  "defaultBranch",
  "integrationBranch",
  "sourceValidationCommands",
  "integrationValidationCommands",
];

/** Include files read by `loadConfigIncludes`, for `applyConfigIncludes`. */
const loadedIncludes = new WeakMap<Config, LoadedInclude[]>();

/**
 * Read the global `include` files and apply their top-level settings to
 * `config` wherever `config.json` does not set them (a later include wins over
 * an earlier one). Run before validating the configuration, so registrations
 * are validated against the effective settings. `validateSetting` throws for
 * an invalid value. Include problems never throw: an include that fails here
 * contributes neither settings nor registrations, and every outcome is
 * recorded in the runtime-only `config.includeReports`.
 */
export async function loadConfigIncludes(
  config: Config,
  runtimeRoot: string,
  validateSetting: (key: string, value: unknown) => void,
  home = homedir(),
): Promise<Config> {
  const entries: unknown = config.include;
  loadedIncludes.set(config, []);
  if (entries === undefined) return config;
  const reports: IncludeReport[] = [];
  hide(config, "includeReports", reports);
  if (!Array.isArray(entries)) {
    reports.push({
      ...emptyReport(1, ""),
      error:
        '"include" must be a list of { "path": "...", "vars": { ... } } entries',
    });
    return config;
  }
  const loaded: LoadedInclude[] = [];
  const settings: { number: number; values: Record<string, unknown> }[] = [];
  for (const [index, entry] of entries.entries()) {
    const number = index + 1;
    const report = emptyReport(
      number,
      isRecord(entry) && typeof entry.path === "string" ? entry.path : "",
    );
    reports.push(report);
    try {
      const { path, vars } = parseEntry(entry);
      const file = resolveIncludePath(path, runtimeRoot, home);
      report.resolvedPath = file;
      const parsed = await readIncludeFile(file);
      const errors: string[] = [];
      const values: Record<string, unknown> = {};
      for (const key of SHARED_SETTINGS)
        if (parsed[key] !== undefined)
          values[key] =
            parsed[key] === null ? null : fill(parsed[key], vars, key, errors);
      const repositories = (
        (parsed.repositories as unknown[] | undefined) ?? []
      ).map((raw, position) => {
        const where = `repositories[${position}]`;
        if (!isRecord(raw)) throw new Error(`${where} must be an object`);
        return fill(raw, vars, where, errors) as RepositoryConfig;
      });
      if (errors.length) throw new Error([...new Set(errors)].join("; "));
      for (const [key, value] of Object.entries(values))
        if (value !== null)
          try {
            validateSetting(key, value);
          } catch (error) {
            throw new Error(
              `invalid "${key}": ${error instanceof Error ? error.message : String(error)}`,
            );
          }
      for (const [position, repository] of repositories.entries())
        checkPaths(repository, `repositories[${position}]`);
      const ignored = Object.keys(parsed).filter(
        (key) =>
          key !== "repositories" &&
          !key.startsWith("$") &&
          !(SHARED_SETTINGS as readonly string[]).includes(key),
      );
      if (ignored.length) report.ignoredKeys = ignored;
      if (Object.keys(values).length) {
        report.settings = [];
        settings.push({ number, values });
      }
      loaded.push({ report, repositories });
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
  }
  const included = new Map<string, { number: number; value: unknown }>();
  for (const key of SHARED_SETTINGS) {
    const sources = settings.filter(({ values }) => key in values);
    if (sources.length === 0) continue;
    const local = config[key];
    const last = sources.at(-1)!;
    const cleared = last.values[key] === null;
    for (const { number, values } of sources) {
      const outcome: IncludedSettingReport =
        local !== undefined
          ? {
              key,
              outcome: isDeepStrictEqual(local, values[key])
                ? "local-same"
                : "local-differs",
            }
          : number === last.number
            ? { key, outcome: cleared ? "cleared" : "used" }
            : { key, outcome: "include", by: last.number };
      reports[number - 1]!.settings!.push(outcome);
    }
    if (local === undefined && !cleared) {
      included.set(key, {
        number: last.number,
        value: structuredClone(last.values[key]),
      });
      (config as unknown as Record<string, unknown>)[key] = structuredClone(
        last.values[key],
      );
    }
  }
  hide(config, "includedSettings", included);
  loadedIncludes.set(config, loaded);
  return config;
}

/**
 * Append the registrations from the include files that `loadConfigIncludes`
 * read (reading them now when it has not) to `config.repositories` after the
 * local ones. A local registration replaces an included one with the same
 * path (or Git common directory). A later include's entry is laid over an
 * earlier include's for the same repository: each key it sets replaces the
 * earlier value whole and `null` removes the key. A registration that fails
 * validation drops that include's registrations, not its settings.
 */
export async function applyConfigIncludes(
  config: Config,
  runtimeRoot: string,
  validateRepository: (config: Config, repository: RepositoryConfig) => void,
  home = homedir(),
): Promise<Config> {
  if (!loadedIncludes.has(config))
    await loadConfigIncludes(config, runtimeRoot, () => undefined, home);
  let candidates: Candidate[] = [];
  for (const { report, repositories } of loadedIncludes.get(config) ?? []) {
    const number = report.number;
    try {
      const loaded: Candidate[] = [];
      const entries: RepositoryConfig[] = [];
      for (const [position, raw] of repositories.entries()) {
        const entry = await realPaths(structuredClone(raw));
        const duplicate = entries.findIndex((other) =>
          sameRepository(other, entry),
        );
        if (duplicate >= 0)
          throw new Error(
            `repositories[${duplicate}] and repositories[${position}] both register ${entry.path}`,
          );
        entries.push(entry);
        const earlier = candidates.find((candidate) =>
          sameRepository(
            candidate.layered as unknown as RepositoryConfig,
            entry,
          ),
        );
        const layered = layer(earlier?.layered ?? {}, entry);
        let included: { repository: RepositoryConfig; exists: boolean };
        try {
          included = await includedRepository(
            structuredClone(layered) as unknown as RepositoryConfig,
            config,
            validateRepository,
          );
        } catch (error) {
          const missing = REQUIRED_REGISTRATION_KEYS.filter(
            (key) => layered[key] === undefined,
          );
          if (earlier || missing.length === 0) throw error;
          throw new Error(
            `repositories[${position}] (${entry.path}) has no ${missing.join(", ")}; no earlier include registers it, so it must be a complete registration`,
          );
        }
        const { repository, exists } = included;
        hide(repository, "includedFrom", {
          number,
          path: report.resolvedPath ?? report.path,
        });
        loaded.push({ layered, repository, report, exists });
      }
      candidates = candidates.filter((earlier) => {
        if (
          !loaded.some((c) => sameRepository(c.repository, earlier.repository))
        )
          return true;
        earlier.report.overridden.push({
          path: earlier.repository.path,
          by: number,
        });
        return false;
      });
      candidates.push(...loaded);
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
  }
  const local = [...config.repositories];
  for (const { repository, report, exists } of candidates) {
    const replacing = local.find((item) => sameRepository(item, repository));
    if (replacing)
      report.overridden.push({
        path: repository.path,
        by: "local",
        identical: sameRegistration(replacing, repository),
      });
    else if (!exists) report.missingCheckouts.push(repository.path);
    else {
      report.loaded.push(repository.path);
      config.repositories.push(repository);
    }
  }
  return config;
}

/**
 * `config` as `config.json` should store it: without registrations loaded
 * from includes, and without included settings that no command changed.
 */
export function localConfig(config: Config): Config {
  const local: Config = {
    ...config,
    repositories: config.repositories.filter(
      (repository) => !repository.includedFrom,
    ),
  };
  for (const [key, { value }] of config.includedSettings ?? [])
    if (isDeepStrictEqual(local[key as keyof Config], value))
      delete local[key as keyof Config];
  return local;
}

/** Every failed include and its error, or undefined when none failed. */
export function failedIncludesText(config: Config): string | undefined {
  const failed = (config.includeReports ?? []).filter((report) => report.error);
  if (failed.length === 0) return undefined;
  return failed
    .map((report) => `${includeLabel(report)} failed to load: ${report.error}`)
    .join("; ");
}

/** Failures, skipped checkouts and ignored keys, for `doctor`. */
export function includeProblems(report: IncludeReport): string[] {
  return [
    ...(report.error ? [`${includeLabel(report)}: ${report.error}`] : []),
    ...report.missingCheckouts.map(
      (path) => `${path}: checkout does not exist yet`,
    ),
    ...(report.ignoredKeys ?? []).map(
      (key) =>
        `${includeLabel(report)}: unknown top-level key "${key}" ignored`,
    ),
  ];
}

/** Local settings and registrations identical to this include's. */
export function redundantLocalEntries(report: IncludeReport): string[] {
  return [
    ...(report.settings ?? [])
      .filter((setting) => setting.outcome === "local-same")
      .map((setting) => setting.key),
    ...report.overridden
      .filter((item) => item.by === "local" && item.identical)
      .map((item) => item.path),
  ];
}

function includeLabel(report: IncludeReport): string {
  return `include ${report.number} (${report.resolvedPath ?? (report.path || "no path")})`;
}

/** Human-readable outcome lines for `status`. */
export function includeReportLines(report: IncludeReport): string[] {
  const used = (report.settings ?? []).filter(
    (setting) => setting.outcome === "used",
  ).length;
  const lines = [
    report.error
      ? `${includeLabel(report)}: not loaded: ${report.error}`
      : `${includeLabel(report)}: ${report.loaded.length} registration(s) loaded${report.settings ? `, ${used} setting(s) used` : ""}`,
  ];
  for (const { key, outcome, by } of report.settings ?? [])
    if (outcome === "local-same")
      lines.push(
        `  setting ${key}: config.json sets the same value (redundant, safe to remove)`,
      );
    else if (outcome === "local-differs")
      lines.push(`  setting ${key}: config.json sets it (local override)`);
    else if (outcome === "include")
      lines.push(`  setting ${key}: replaced by include ${by}`);
    else if (outcome === "cleared")
      lines.push(`  setting ${key}: removed (null); no included value`);
  for (const { path, by, identical } of report.overridden)
    lines.push(
      `  ${path}: replaced by ${
        by !== "local"
          ? `include ${by}`
          : identical
            ? "an identical local registration (redundant, safe to remove)"
            : "a local registration (local override)"
      }`,
    );
  for (const path of report.missingCheckouts)
    lines.push(`  ${path}: checkout does not exist yet; skipped`);
  for (const key of report.ignoredKeys ?? [])
    lines.push(`  unknown top-level key "${key}": ignored`);
  return lines;
}

function emptyReport(number: number, path: string): IncludeReport {
  return { number, path, loaded: [], overridden: [], missingCheckouts: [] };
}

function parseEntry(entry: unknown): {
  path: string;
  vars: Record<string, string>;
} {
  if (!isRecord(entry))
    throw new Error(
      'an include entry must be an object like { "path": "...", "vars": { ... } }',
    );
  for (const key of Object.keys(entry))
    if (key !== "path" && key !== "vars")
      throw new Error(
        `unknown key "${key}"; an include entry has only "path" and "vars"`,
      );
  if (typeof entry.path !== "string" || !entry.path.trim())
    throw new Error('"path" must be a non-empty string');
  const vars = entry.vars ?? {};
  if (!isRecord(vars)) throw new Error('"vars" must be an object of strings');
  for (const [name, value] of Object.entries(vars)) {
    if (!NAME.test(name))
      throw new Error(
        `invalid vars name "${name}"; use letters, digits and _ only`,
      );
    if (typeof value !== "string")
      throw new Error(`vars.${name} must be a string`);
  }
  return { path: entry.path, vars: vars as Record<string, string> };
}

/** `~` and `~/...` expand to the home directory; relative paths use the runtime directory. */
export function resolveIncludePath(
  path: string,
  runtimeRoot: string,
  home = homedir(),
): string {
  if (path === "~") return resolve(home);
  if (/^~[\\/]/.test(path)) return resolve(home, path.slice(2));
  return resolve(runtimeRoot, path);
}

async function readIncludeFile(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`file not found: ${path}`);
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`not valid JSON: ${(error as Error).message}`);
  }
  if (
    !isRecord(parsed) ||
    (parsed.repositories !== undefined && !Array.isArray(parsed.repositories))
  )
    throw new Error(
      'the file must be a JSON object of settings and an optional "repositories" list',
    );
  for (const key of LOCAL_ONLY)
    if (key in parsed)
      throw new Error(
        `"${key}" is allowed only in config.json, not in an included file`,
      );
  return parsed;
}

function checkPaths(repository: RepositoryConfig, where: string): void {
  for (const key of ["path", "gitCommonDir"] as const) {
    const value: unknown = repository[key];
    if (typeof value !== "string" || !isAbsolute(value))
      throw new Error(
        `${where}.${key} must be an absolute path once placeholders are filled`,
      );
    repository[key] = resolve(value);
  }
}

async function includedRepository(
  repository: RepositoryConfig,
  config: Config,
  validateRepository: (config: Config, repository: RepositoryConfig) => void,
): Promise<{ repository: RepositoryConfig; exists: boolean }> {
  repository.conflictInstructions ??= "";
  if (
    !Array.isArray(repository.setupCommands ?? []) ||
    !Array.isArray(repository.postIntegrationCommands ?? []) ||
    typeof repository.conflictInstructions !== "string"
  )
    throw new Error(`Invalid command configuration for ${repository.path}`);
  validateRepository(config, repository);
  const exists =
    existsSync(repository.path) && existsSync(repository.gitCommonDir);
  return { repository, exists };
}

/** Match local registrations and Git, which record real paths. */
async function realPaths(
  repository: RepositoryConfig,
): Promise<RepositoryConfig> {
  if (existsSync(repository.path) && existsSync(repository.gitCommonDir)) {
    repository.path = await realpath(repository.path);
    repository.gitCommonDir = await realpath(repository.gitCommonDir);
  }
  return repository;
}

/** `patch` over `base`: each key replaces the earlier value whole; `null` removes it. */
function layer(
  base: Record<string, unknown>,
  patch: object,
): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch))
    if (value === null) delete out[key];
    else out[key] = structuredClone(value);
  return out;
}

/** Fill placeholders in parsed string values only, never in keys or raw text. */
function fill(
  value: unknown,
  vars: Record<string, string>,
  where: string,
  errors: string[],
): unknown {
  if (typeof value === "string")
    return value.replace(PLACEHOLDER, (match, name: string) => {
      if (!NAME.test(name)) {
        errors.push(
          `${where}: malformed placeholder ${match}; write {{name}} with no spaces`,
        );
        return match;
      }
      if (!Object.hasOwn(vars, name)) {
        errors.push(
          `${where}: unknown placeholder {{${name}}}; add "${name}" to this include's vars`,
        );
        return match;
      }
      return vars[name]!;
    });
  if (Array.isArray(value))
    return value.map((item, index) =>
      fill(item, vars, `${where}[${index}]`, errors),
    );
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        fill(item, vars, `${where}.${key}`, errors),
      ]),
    );
  return value;
}

function sameRepository(a: RepositoryConfig, b: RepositoryConfig): boolean {
  return a.path === b.path || a.gitCommonDir === b.gitCommonDir;
}

/**
 * Equal effective settings once defaults are filled; runtime-only
 * (non-enumerable) properties are ignored.
 */
function sameRegistration(a: RepositoryConfig, b: RepositoryConfig): boolean {
  const stored = (repository: RepositoryConfig) => {
    const copy = JSON.parse(JSON.stringify(repository)) as RepositoryConfig;
    copy.conflictInstructions ??= "";
    return copy;
  };
  return isDeepStrictEqual(stored(a), stored(b));
}

function hide(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
