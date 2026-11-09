import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveIncludePath } from "./config-include.js";
import { preflightRuntimeCompatibility } from "./coordinator.js";
import { repositoryCommonDir } from "./enablement.js";
import { registerCommand } from "./handoff.js";
import {
  isNodeError,
  loadConfig,
  runtimePaths,
  withConfigLock,
  writeConfigFile,
} from "./runtime.js";
import type { Config } from "./types.js";

export const configUsage =
  "Usage: seshx config apply [--layer <file>]... [--var <name>=<value>]... [--drop-include <path>]... [--register <repo-path>]... [--check]";

/** `--check` exits 1 for pending work; every error exits with this code. */
const ERROR_EXIT = 2;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ApplyOptions {
  /** Include paths in order: absolute, or `~/...` as given. */
  layers: string[];
  vars: Record<string, string>;
  drops: string[];
  register: string[];
  check: boolean;
}

interface Plan {
  /** Raw `config.json` to write, or undefined when it needs no change. */
  next: Record<string, unknown> | undefined;
  pending: string[];
  notes: string[];
  dropped: string[];
  unregistered: string[];
}

export async function configCommand(args: string[]): Promise<void> {
  try {
    const [action, ...rest] = args;
    if (action !== "apply") throw new Error(configUsage);
    await apply(parseApplyOptions(rest));
  } catch (error) {
    // Keep the original error so capability failures are still recognized.
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      { exitCode: ERROR_EXIT },
    );
  }
}

function parseApplyOptions(args: string[]): ApplyOptions {
  const options: ApplyOptions = {
    layers: [],
    vars: {},
    drops: [],
    register: [],
    check: false,
  };
  const given = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    const value = args[index + 1];
    if (
      !["--layer", "--var", "--drop-include", "--register"].includes(
        argument,
      ) ||
      value === undefined ||
      value === "" ||
      value.startsWith("--")
    )
      throw new Error(
        `Unknown or incomplete option: ${argument}\n${configUsage}`,
      );
    index += 1;
    if (argument === "--layer") {
      const path = includePath(value);
      if (options.layers.includes(path))
        throw new Error(`--layer ${value} is given twice`);
      options.layers.push(path);
    } else if (argument === "--drop-include")
      options.drops.push(includePath(value));
    else if (argument === "--register") options.register.push(resolve(value));
    else {
      const at = value.indexOf("=");
      const name = value.slice(0, at);
      if (at < 1 || !VAR_NAME.test(name))
        throw new Error(
          `--var needs name=value with a name of letters, digits and _, not ${value}`,
        );
      const text = value.slice(at + 1);
      if (given.has(name) && given.get(name) !== text)
        throw new Error(`--var ${name} is given twice with different values`);
      given.set(name, text);
    }
  }
  if (given.size && !options.layers.length)
    throw new Error("--var needs at least one --layer");
  // An empty value is left out, so a layer that uses it fails loudly.
  for (const [name, text] of [...given].sort(([a], [b]) => a.localeCompare(b)))
    if (text) options.vars[name] = text;
  return options;
}

/** `~` stays as given (seshx expands it); anything else becomes absolute. */
function includePath(value: string): string {
  return value === "~" || /^~[\\/]/.test(value) ? value : resolve(value);
}

async function apply(options: ApplyOptions): Promise<void> {
  const paths = runtimePaths();
  const plan = await prepare(options);
  if (options.check) {
    if (plan.pending.length) {
      process.stdout.write(
        [`Pending: ${plan.pending.join("; ")}`, ...plan.notes].join("\n") +
          "\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      [`Up to date: ${paths.config}`, ...plan.notes].join("\n") + "\n",
    );
    return;
  }
  // Like register, refuse to write while session records need another build.
  await preflightRuntimeCompatibility();
  for (const note of plan.notes) process.stdout.write(`${note}\n`);
  let changed = false;
  if (plan.next) {
    // A new config.json holds only what this command sets, so included
    // settings are not shadowed by the defaults other commands write.
    await mkdir(paths.root, { recursive: true });
    try {
      await writeFile(paths.config, '{\n  "repositories": []\n}\n', {
        flag: "wx",
      });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    changed = await withConfigLock(async () => {
      // Recheck under the lock: another command may have changed the file.
      const locked = await prepare(options);
      if (!locked.next) return false;
      await writeConfigFile(
        paths.config,
        locked.next as unknown as Config,
        "seshx config apply",
      );
      const vars = Object.keys(options.vars);
      if (options.layers.length)
        process.stdout.write(
          `Included ${options.layers.length} layer(s)${vars.length ? ` with vars ${vars.join(", ")}` : ""} in ${paths.config}\n`,
        );
      for (const path of locked.dropped)
        process.stdout.write(`Stopped including ${path}\n`);
      return true;
    });
  }
  // register refuses a new local registration while an include fails, so it
  // runs after the include is set.
  for (const path of plan.unregistered) {
    process.stdout.write(
      `Registering ${path} (seshx register --auto-config)\n`,
    );
    await registerCommand(path, true);
    changed = true;
  }
  if (!changed) process.stdout.write(`Up to date: ${paths.config}\n`);
}

/** What `config.json` should become, checked against the layers it names. */
async function prepare(options: ApplyOptions): Promise<Plan> {
  const paths = runtimePaths();
  const home = homedir();
  const current = await readRawConfig(paths.config);
  for (const name of ["include", "repositories"])
    if (current?.[name] !== undefined && !Array.isArray(current[name]))
      throw new Error(
        `"${name}" in ${paths.config} is not a list; fix it by hand, then run this again`,
      );
  const existing = (current?.include as unknown[] | undefined) ?? [];
  const target = (path: string) =>
    comparable(resolveIncludePath(path, paths.root, home));
  const layerFiles = new Set(options.layers.map(target));
  const dropFiles = options.drops.map(target);
  const others: unknown[] = [];
  const dropped: string[] = [];
  let position: number | undefined;
  for (const entry of existing) {
    const path = entryPath(entry);
    const file = path === undefined ? undefined : target(path);
    const ours = file !== undefined && layerFiles.has(file);
    const drop =
      !ours &&
      file !== undefined &&
      dropFiles.some((base) => file === base || file.startsWith(base + sep));
    if (ours || drop) position ??= others.length;
    if (drop) dropped.push(path!);
    if (!ours && !drop) others.push(entry);
  }
  // The layers keep the place of the entries they replace; new ones go last.
  const at = position ?? others.length;
  const block = options.layers.map((path) =>
    Object.keys(options.vars).length
      ? { path, vars: { ...options.vars } }
      : { path },
  );
  const include = [...others.slice(0, at), ...block, ...others.slice(at)];
  const managed = options.layers.length > 0 || options.drops.length > 0;
  const includeChanged =
    managed &&
    !isDeepStrictEqual(include, existing) &&
    (include.length > 0 || current?.include !== undefined);
  const missingList =
    (options.layers.length > 0 || current !== undefined) &&
    !Array.isArray(current?.repositories);
  const pending: string[] = [];
  if (includeChanged) {
    if (options.layers.length)
      pending.push(
        `${paths.config} does not include the ${options.layers.length} layer(s) in this order with these vars`,
      );
    if (dropped.length)
      pending.push(`${paths.config} still includes ${dropped.join(", ")}`);
  }
  if (missingList && current !== undefined)
    pending.push(`${paths.config} has no "repositories" list`);

  let next: Record<string, unknown> | undefined;
  if (includeChanged || missingList) {
    next = { ...(current ?? {}) };
    if (include.length) next.include = include;
    else delete next.include;
    next.repositories ??= [];
  }
  const effective = await effectiveConfig(
    next ?? current ?? { repositories: [] },
    paths,
  );
  const notes: string[] = [];
  const failures: string[] = [];
  for (const report of effective.includeReports ?? []) {
    const index = report.number - 1;
    if (index < at || index >= at + block.length) continue;
    const label = `layer ${report.resolvedPath ?? report.path}`;
    if (report.error) failures.push(`${label}: ${report.error}`);
    for (const path of report.missingCheckouts)
      notes.push(`Note: ${path} (from ${label}) has no checkout yet; skipped`);
    for (const key of report.ignoredKeys ?? [])
      notes.push(`Note: ${label} has unknown top-level key "${key}"; ignored`);
  }
  if (failures.length)
    throw new Error(
      `${failures.join("; ")}. Nothing was changed; fix the layer or its --var values, then run this again.`,
    );
  const unregistered: string[] = [];
  for (const path of options.register) {
    if (!existsSync(join(path, ".git"))) {
      notes.push(`Note: ${path} is not a Git checkout yet; not registered`);
      continue;
    }
    const commonDir = await repositoryCommonDir(path);
    if (
      !effective.repositories.some(
        (repository) => repository.gitCommonDir === commonDir,
      )
    ) {
      unregistered.push(path);
      pending.push(`${path} is not registered`);
    }
  }
  return { next, pending, notes, dropped, unregistered };
}

async function readRawConfig(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${(error as Error).message}); fix it by hand, then run this again`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(
      `${path} is not a JSON object; fix it by hand, then run this again`,
    );
  return parsed as Record<string, unknown>;
}

async function effectiveConfig(
  raw: Record<string, unknown>,
  paths: { root: string; config: string },
): Promise<Config> {
  try {
    return await loadConfig(structuredClone(raw) as unknown as Config, paths);
  } catch (error) {
    throw new Error(
      `${paths.config} is not valid: ${error instanceof Error ? error.message : String(error)}; fix it by hand, then run this again`,
    );
  }
}

function entryPath(entry: unknown): string | undefined {
  return entry &&
    typeof entry === "object" &&
    typeof (entry as { path?: unknown }).path === "string"
    ? (entry as { path: string }).path
    : undefined;
}

function comparable(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
