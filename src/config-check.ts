import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { SHARED_SETTINGS, resolveIncludePath } from "./config-include.js";
import { loadConfig } from "./runtime.js";
import type { Config } from "./types.js";

/** One layer file to check: its include path and the path as the user gave it. */
export interface CheckLayer {
  path: string;
  label: string;
}

export interface CheckOptions {
  layers: CheckLayer[];
  vars: Record<string, string>;
  /** Report machine-specific paths. */
  portable: boolean;
  /** Report what coordinators older than layering cannot read. */
  olderCoordinators: boolean;
}

/** Keys coordinators older than layering need in every included registration. */
const OLDER_REQUIRED_KEYS = [
  "path",
  "gitCommonDir",
  "defaultBranch",
  "integrationBranch",
  "sourceValidationCommands",
  "integrationValidationCommands",
];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GITHUB_TOKEN = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]/;

/** Home folders, Windows drive paths and Node version-manager installs. */
const MACHINE_PATHS = [
  /(?<![\w.~-])\/(?:home|Users)\//,
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/,
  /node-versions|\.nvm[\\/]versions/,
];

/**
 * Check layer files the way `config apply` would load them, without reading
 * or writing a runtime directory: one line per problem, in the form
 * `FILE: [REGISTRATION: ]RULE: message`. An empty list means every check passed.
 */
export async function checkLayers(options: CheckOptions): Promise<string[]> {
  const problems: string[] = [];
  const raw = {
    repositories: [],
    include: options.layers.map(({ path }) =>
      Object.keys(options.vars).length
        ? { path, vars: { ...options.vars } }
        : { path },
    ),
  } as unknown as Config;
  // The include paths are absolute or `~/...`, so the root only labels errors.
  let config: Config | undefined;
  try {
    config = await loadConfig(raw, {
      root: process.cwd(),
      config: "the combined layers",
    });
  } catch (error) {
    problems.push(
      `${options.layers.map(({ label }) => label).join(", ")}: load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const [index, layer] of options.layers.entries()) {
    const report = config?.includeReports?.[index];
    // A file that does not parse is reported by its load error alone.
    const parsed = await readJson(
      report?.resolvedPath ??
        resolveIncludePath(layer.path, process.cwd(), homedir()),
    );
    const placeholders =
      parsed === undefined
        ? []
        : placeholderProblems(layer.label, parsed, options.vars);
    // Placeholders are filled before anything else is checked, so their
    // failure is the whole load error; list each placeholder per registration.
    if (
      report?.error &&
      !(placeholders.length && report.error.includes("placeholder"))
    )
      problems.push(`${layer.label}: load: ${report.error}`);
    problems.push(...placeholders);
    for (const key of report?.ignoredKeys ?? [])
      problems.push(
        `${layer.label}: ${key}: load: unknown top-level key (config apply ignores it)`,
      );
    if (parsed !== undefined)
      problems.push(...fileProblems(layer.label, parsed, options));
  }
  return problems;
}

/** Placeholders `config apply` cannot fill with these vars, once per name and place. */
function placeholderProblems(
  label: string,
  parsed: unknown,
  vars: Record<string, string>,
): string[] {
  if (!isRecord(parsed)) return [];
  /** `where: placeholder` to its hint and how many values use it. */
  const found = new Map<string, { hint: string; count: number }>();
  const note = (where: string, problem: string, hint: string) => {
    const key = `${where}: load: ${problem}`;
    found.set(key, { hint, count: (found.get(key)?.count ?? 0) + 1 });
  };
  const scan = (value: unknown, where: string) =>
    walk(value, [], (item, _location, isKey) => {
      if (isKey || typeof item !== "string") return;
      for (const [match, name] of item.matchAll(/\{\{(.*?)\}\}/g))
        if (!NAME.test(name!))
          note(
            where,
            `malformed placeholder ${match}`,
            "write {{name}} with no spaces",
          );
        else if (!Object.hasOwn(vars, name!))
          note(
            where,
            `unknown placeholder {{${name}}}`,
            `pass --var ${name}=VALUE`,
          );
    });
  // Like config apply: only settings and registrations are filled.
  for (const key of SHARED_SETTINGS)
    if (parsed[key] !== undefined && parsed[key] !== null)
      scan(parsed[key], key);
  if (Array.isArray(parsed.repositories))
    parsed.repositories.forEach((entry, position) => {
      if (isRecord(entry)) scan(entry, registrationName(entry, position));
    });
  return [...found].map(
    ([problem, { hint, count }]) =>
      `${label}: ${problem}${count > 1 ? ` in ${count} values` : ""}; ${hint}`,
  );
}

function fileProblems(
  label: string,
  parsed: unknown,
  options: CheckOptions,
): string[] {
  const problems: string[] = [];
  const at = (where: string[], rule: string, message: string) =>
    problems.push(
      [label, ...(where.length ? [where.join(" ")] : []), rule, message].join(
        ": ",
      ),
    );
  const record = isRecord(parsed) ? parsed : {};
  const repositories = record.repositories;
  if (options.olderCoordinators && !Array.isArray(repositories))
    at(
      [],
      "older-coordinators",
      'no "repositories" list; older coordinators reject an included file without one (add "repositories": [])',
    );
  walk(parsed, [], (value, location, isKey) => {
    const where = describe(location, repositories);
    if (typeof value === "string" && GITHUB_TOKEN.test(value))
      at(
        where,
        "token",
        `${isKey ? "a key" : "a value"} looks like a GitHub token; remove it and keep secrets out of configuration`,
      );
    if (
      options.portable &&
      !isKey &&
      typeof value === "string" &&
      MACHINE_PATHS.some((pattern) => pattern.test(value))
    )
      at(
        where,
        "portable",
        `machine-specific path ${JSON.stringify(value)}; use a {{name}} placeholder and pass --var`,
      );
    if (options.olderCoordinators && value === null)
      at(
        where,
        "older-coordinators",
        "null; older coordinators fail an include that sets null",
      );
  });
  if (options.olderCoordinators && Array.isArray(repositories))
    for (const [position, entry] of repositories.entries()) {
      if (!isRecord(entry)) continue;
      const missing = OLDER_REQUIRED_KEYS.filter((key) => !(key in entry));
      if (missing.length)
        at(
          [registrationName(entry, position)],
          "older-coordinators",
          `no ${missing.join(", ")}; older coordinators replace an included registration whole, so it must be complete`,
        );
    }
  return problems;
}

/** The registration (by its `path` as written) and the place inside it. */
function describe(
  location: (string | number)[],
  repositories: unknown,
): string[] {
  if (location[0] !== "repositories" || typeof location[1] !== "number")
    return location.length ? [pointer(location)] : [];
  const entry = (repositories as unknown[])[location[1]];
  const name = registrationName(entry, location[1]);
  const inner = location.slice(2);
  return inner.length ? [name, `(${pointer(inner)})`] : [name];
}

function registrationName(entry: unknown, position: number): string {
  return isRecord(entry) && typeof entry.path === "string" && entry.path
    ? entry.path
    : `repositories[${position}]`;
}

function pointer(location: (string | number)[]): string {
  return location
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : index ? `.${part}` : part,
    )
    .join("");
}

/** Visit every value and key; keys are reported at their own location. */
function walk(
  value: unknown,
  location: (string | number)[],
  visit: (
    value: unknown,
    location: (string | number)[],
    isKey: boolean,
  ) => void,
): void {
  visit(value, location, false);
  if (Array.isArray(value))
    value.forEach((item, index) => walk(item, [...location, index], visit));
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      visit(key, [...location, key], true);
      walk(item, [...location, key], visit);
    }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
