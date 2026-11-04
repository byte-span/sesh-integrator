import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Config, IncludeReport, RepositoryConfig } from "./types.js";

/** `{{name}}`; anything else between the braces is a malformed placeholder. */
const PLACEHOLDER = /\{\{(.*?)\}\}/g;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Candidate {
  repository: RepositoryConfig;
  report: IncludeReport;
  exists: boolean;
}

/**
 * Load the registrations listed by the global `include` entries and append
 * them to `config.repositories` after the local ones. A local registration
 * replaces an included one with the same path (or Git common directory), and
 * a later include replaces an earlier one. Include problems never throw: an
 * include that fails contributes nothing, and every outcome is recorded in
 * the runtime-only `config.includeReports`.
 */
export async function applyConfigIncludes(
  config: Config,
  runtimeRoot: string,
  validateRepository: (config: Config, repository: RepositoryConfig) => void,
  home = homedir(),
): Promise<Config> {
  const entries: unknown = config.include;
  if (entries === undefined) return config;
  const reports: IncludeReport[] = [];
  Object.defineProperty(config, "includeReports", {
    value: reports,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  if (!Array.isArray(entries)) {
    reports.push({
      ...emptyReport(1, ""),
      error:
        '"include" must be a list of { "path": "...", "vars": { ... } } entries',
    });
    return config;
  }
  let candidates: Candidate[] = [];
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
      const loaded: Candidate[] = [];
      for (const [position, raw] of (await readIncludeFile(file)).entries()) {
        const { repository, exists } = await includedRepository(
          raw,
          vars,
          `repositories[${position}]`,
          config,
          validateRepository,
        );
        const duplicate = loaded.findIndex((other) =>
          sameRepository(other.repository, repository),
        );
        if (duplicate >= 0)
          throw new Error(
            `repositories[${duplicate}] and repositories[${position}] both register ${repository.path}`,
          );
        Object.defineProperty(repository, "includedFrom", {
          value: { number, path: file },
          configurable: true,
          enumerable: false,
          writable: true,
        });
        loaded.push({ repository, report, exists });
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
    if (local.some((item) => sameRepository(item, repository)))
      report.overridden.push({ path: repository.path, by: "local" });
    else if (!exists) report.missingCheckouts.push(repository.path);
    else {
      report.loaded.push(repository.path);
      config.repositories.push(repository);
    }
  }
  return config;
}

/** Every failed include and its error, or undefined when none failed. */
export function failedIncludesText(config: Config): string | undefined {
  const failed = (config.includeReports ?? []).filter((report) => report.error);
  if (failed.length === 0) return undefined;
  return failed
    .map((report) => `${includeLabel(report)} failed to load: ${report.error}`)
    .join("; ");
}

/** Failures and skipped checkouts, for `doctor`. */
export function includeProblems(report: IncludeReport): string[] {
  return [
    ...(report.error ? [`${includeLabel(report)}: ${report.error}`] : []),
    ...report.missingCheckouts.map(
      (path) => `${path}: checkout does not exist yet`,
    ),
  ];
}

function includeLabel(report: IncludeReport): string {
  return `include ${report.number} (${report.resolvedPath ?? (report.path || "no path")})`;
}

/** Human-readable outcome lines for `status`. */
export function includeReportLines(report: IncludeReport): string[] {
  const lines = [
    report.error
      ? `${includeLabel(report)}: not loaded: ${report.error}`
      : `${includeLabel(report)}: ${report.loaded.length} registration(s) loaded`,
  ];
  for (const { path, by } of report.overridden)
    lines.push(
      `  ${path}: replaced by ${by === "local" ? "a local registration" : `include ${by}`}`,
    );
  for (const path of report.missingCheckouts)
    lines.push(`  ${path}: checkout does not exist yet; skipped`);
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
function resolveIncludePath(
  path: string,
  runtimeRoot: string,
  home = homedir(),
): string {
  if (path === "~") return resolve(home);
  if (/^~[\\/]/.test(path)) return resolve(home, path.slice(2));
  return resolve(runtimeRoot, path);
}

async function readIncludeFile(path: string): Promise<unknown[]> {
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
  if (!isRecord(parsed) || !Array.isArray(parsed.repositories))
    throw new Error(
      'the file must be a JSON object with a "repositories" list',
    );
  return parsed.repositories;
}

async function includedRepository(
  raw: unknown,
  vars: Record<string, string>,
  where: string,
  config: Config,
  validateRepository: (config: Config, repository: RepositoryConfig) => void,
): Promise<{ repository: RepositoryConfig; exists: boolean }> {
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);
  const errors: string[] = [];
  const repository = fill(raw, vars, where, errors) as RepositoryConfig;
  if (errors.length) throw new Error([...new Set(errors)].join("; "));
  for (const key of ["path", "gitCommonDir"] as const) {
    const value: unknown = repository[key];
    if (typeof value !== "string" || !isAbsolute(value))
      throw new Error(
        `${where}.${key} must be an absolute path once placeholders are filled`,
      );
    repository[key] = resolve(value);
  }
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
  // Match local registrations and Git, which record real paths.
  if (exists) {
    repository.path = await realpath(repository.path);
    repository.gitCommonDir = await realpath(repository.gitCommonDir);
  }
  return { repository, exists };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
