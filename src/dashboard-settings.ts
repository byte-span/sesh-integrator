import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  configHistoryLimit,
  listConfigHistory,
  readConfigSnapshot,
  type ConfigSnapshot,
  type ConfigSnapshotSummary,
} from "./config-history.js";
import {
  settingsSuggestions,
  type SettingsSuggestions,
} from "./dashboard-suggestions.js";
import { withCleanup } from "./file-lock.js";
import {
  harnessCommand,
  harnessInfo,
  harnesses,
  type Harness,
} from "./harness.js";
import { acquireRepoLock, releaseRepoLock, type LockHandle } from "./lock.js";
import { targetBranch, targetBranchSource } from "./promotion.js";
import {
  defaultConfig,
  isNodeError,
  isPlausibleBranchName,
  repoId,
  runtimePaths,
  validateConfig,
  withConfigLock,
  writeConfigFile,
} from "./runtime.js";
import type {
  Config,
  DefaultPromotionConfig,
  RepositoryConfig,
  ValidationCommand,
  ValidationStep,
} from "./types.js";

// The form edits only these scalar settings. Validation commands and the
// branches that identify a registration stay in the JSON tab and the CLI.
const conflictModes = ["current-session", "nested-agent", "nested-codex"];
const validationCaches = ["off", "session", "repository"];
const setupPolicies = ["required", "advisory"];
const promotionModes = ["shared-target", "session-branch"];

export interface GlobalSettings {
  defaultTargetBranch: string;
  lockWaitSeconds: number;
  conflictResolutionMode: string;
  reviewers: string[];
  assignees: string[];
  deliveryPolicyFile: string;
  /** Program per harness; `""` uses the harness default on PATH. */
  harnessCommands: Record<Harness, string>;
}

export interface RepositorySettings {
  enabled: boolean;
  targetBranch: string;
  promotion: {
    type: "none" | "pull-request";
    mode: string;
    productionBranch: string;
    remote: string;
    /** `null` inherits the global default; `[]` explicitly requests none. */
    reviewers: string[] | null;
    assignees: string[] | null;
  };
  validationCache: string;
  setupCommandPolicy: string;
  conflictInstructions: string;
  /** `""` uses Git's own gpg.program. */
  gpgProgram: string;
}

export type SettingsRequest =
  | { scope: "global"; revision: string; values: GlobalSettings }
  | {
      scope: "repository";
      revision: string;
      repository: string;
      values: RepositorySettings;
    };

interface StoredConfig {
  text: string | null;
  config: Config;
}

async function readConfigText(): Promise<string | null> {
  try {
    return await readFile(runtimePaths().config, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return null;
  }
}

async function readStoredConfig(): Promise<StoredConfig> {
  const text = await readConfigText();
  if (text === null) return { text, config: defaultConfig() };
  try {
    return { text, config: JSON.parse(text) as Config };
  } catch {
    throw new Error(`Invalid configuration: ${runtimePaths().config}`);
  }
}

const defaultConfigText = () => `${JSON.stringify(defaultConfig(), null, 2)}\n`;

/** Identifies the exact stored bytes so a stale form never overwrites newer edits. */
export function settingsRevision(text: string | null): string {
  return createHash("sha256")
    .update(text ?? "\0absent")
    .digest("hex");
}

function assertCurrent(text: string | null, revision: string): void {
  // Taking the config lock writes the default file into a fresh runtime;
  // that untouched default still matches a form loaded before it existed.
  const createdDefault =
    revision === settingsRevision(null) && text === defaultConfigText();
  if (settingsRevision(text) !== revision && !createdDefault)
    throw new Error(
      "Settings changed since this form was loaded. Choose Discard changes to load the latest values, then reapply your edits.",
    );
}

function quote(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument)
    ? argument
    : JSON.stringify(argument);
}

function commandText(command: ValidationCommand): string {
  return (Array.isArray(command) ? command : command.command)
    .map(quote)
    .join(" ");
}

function stepLines(steps: ValidationStep[]): string[] {
  return steps.flatMap((step) =>
    "parallel" in step
      ? ["In parallel:", ...step.parallel.map((c) => "  " + commandText(c))]
      : [commandText(step)],
  );
}

function globalSettings(config: Config): GlobalSettings {
  return {
    defaultTargetBranch: config.defaultTargetBranch ?? "",
    lockWaitSeconds: config.lockWaitSeconds,
    conflictResolutionMode: config.conflictResolutionMode ?? "current-session",
    reviewers: config.defaultPromotion?.reviewers ?? [],
    assignees: config.defaultPromotion?.assignees ?? [],
    deliveryPolicyFile: config.deliveryPolicyFile ?? "",
    harnessCommands: Object.fromEntries(
      harnesses.map((harness) => [harness, configuredCommand(config, harness)]),
    ) as Record<Harness, string>,
  };
}

function configuredCommand(config: Config, harness: Harness): string {
  return (
    config.harnessCommands?.[harness] ??
    (harness === "codex" ? config.codexCommand : undefined) ??
    ""
  );
}

const defaultCommand = (harness: Harness) =>
  harnessInfo[harness].command ?? harness;

function repositorySettings(
  config: Config,
  repository: RepositoryConfig,
): RepositorySettings {
  const promotion = repository.promotion ?? { type: "none" };
  const pullRequest = promotion.type === "pull-request" ? promotion : undefined;
  return {
    enabled: !(config.disabledRepositories ?? []).includes(
      repository.gitCommonDir,
    ),
    targetBranch: repository.targetBranch ?? "",
    promotion: {
      type: promotion.type,
      mode: pullRequest?.mode ?? "shared-target",
      productionBranch: pullRequest?.productionBranch ?? "",
      remote: pullRequest?.remote ?? "",
      reviewers: pullRequest?.reviewers ?? null,
      assignees: pullRequest?.assignees ?? null,
    },
    validationCache: repository.validationCache ?? "session",
    setupCommandPolicy: repository.setupCommandPolicy ?? "required",
    conflictInstructions: repository.conflictInstructions,
    gpgProgram: repository.gpgProgram ?? "",
  };
}

/** Browser projection of the stored configuration. */
export function settingsView(text: string | null, stored: Config) {
  const paths = runtimePaths();
  const config = validateConfig(structuredClone(stored), paths.config);
  return {
    revision: settingsRevision(text),
    configPath: paths.config,
    exists: text !== null,
    global: globalSettings(config),
    harnesses: harnesses.map((harness) => ({
      id: harness,
      name: harnessInfo[harness].name,
      defaultCommand: defaultCommand(harness),
      effectiveCommand: harnessCommand(config, harness),
    })),
    repositories: config.repositories.map((repository) => ({
      path: repository.path,
      name: basename(repository.path),
      gitCommonDir: repository.gitCommonDir,
      defaultBranch: repository.defaultBranch,
      integrationBranch: repository.integrationBranch,
      effectiveTargetBranch: targetBranch(repository),
      targetSource: targetBranchSource(repository),
      inheritedTargetBranch:
        config.defaultTargetBranch ?? repository.defaultBranch,
      ...repositorySettings(config, repository),
      commands: [
        { label: "Setup", lines: repository.setupCommands.map(commandText) },
        {
          label: "Source validation",
          lines: stepLines(repository.sourceValidationCommands),
        },
        {
          label: "Integration validation",
          lines: stepLines(repository.integrationValidationCommands),
        },
        {
          label: "Post-integration",
          lines: repository.postIntegrationCommands.map(commandText),
        },
      ],
      validationTiers: (repository.validationTiers ?? []).map((tier) => ({
        name: tier.name,
        paths: tier.paths,
        source: stepLines(tier.sourceValidationCommands),
        integration: stepLines(tier.integrationValidationCommands),
        bypassIntegrationWorktree: !!tier.bypassIntegrationWorktree,
      })),
    })),
  };
}

export type SettingsView = ReturnType<typeof settingsView>;

export async function loadSettings(): Promise<SettingsView> {
  const stored = await readStoredConfig();
  return settingsView(stored.text, stored.config);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  if (!isDeepStrictEqual(actual, [...keys].sort()))
    throw new Error(`Invalid ${label}: expected ${keys.join(", ")}`);
}

function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw new Error(`${label} must be text up to ${max} characters`);
  return value;
}

function branch(value: unknown, label: string): string {
  const name = text(value, label, 255).trim();
  if (name && !isPlausibleBranchName(name))
    throw new Error(`${label} is not a valid branch name: ${name}`);
  return name;
}

function choice(value: unknown, options: string[], label: string): string {
  if (typeof value !== "string" || !options.includes(value))
    throw new Error(`${label} must be one of ${options.join(", ")}`);
  return value;
}

function participants(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new Error(`${label} must be a list of GitHub users or teams`);
  return value.map((entry) => {
    const name = typeof entry === "string" ? entry.trim() : "";
    // Names become `gh` arguments; refuse anything that could read as an option.
    if (!/^[A-Za-z0-9][\w.\/-]{0,99}$/.test(name))
      throw new Error(`${label} contains an invalid name: ${String(entry)}`);
    return name;
  });
}

function optionalParticipants(value: unknown, label: string): string[] | null {
  return value === null ? null : participants(value, label);
}

/** A program path or name. Commands are never run through a shell. */
function program(value: unknown, label: string): string {
  const name = text(value, label).trim();
  if (/[\r\n]/.test(name)) throw new Error(`${label} must be a single line`);
  return name;
}

function harnessCommands(value: unknown): Record<Harness, string> {
  const commands = object(value, "agent commands");
  exactKeys(commands, harnesses, "agent commands");
  return Object.fromEntries(
    harnesses.map((harness) => [
      harness,
      program(commands[harness], `${harnessInfo[harness].name} command`),
    ]),
  ) as Record<Harness, string>;
}

export function parseSettingsRequest(value: unknown): SettingsRequest {
  const request = object(value, "settings request");
  const revision = request.revision;
  if (typeof revision !== "string" || !/^[0-9a-f]{64}$/.test(revision))
    throw new Error("Invalid settings revision");
  const values = object(request.values, "settings values");
  if (request.scope === "global") {
    exactKeys(request, ["scope", "revision", "values"], "settings request");
    exactKeys(
      values,
      [
        "defaultTargetBranch",
        "lockWaitSeconds",
        "conflictResolutionMode",
        "reviewers",
        "assignees",
        "deliveryPolicyFile",
        "harnessCommands",
      ],
      "global settings",
    );
    const wait = values.lockWaitSeconds;
    if (
      typeof wait !== "number" ||
      !Number.isInteger(wait) ||
      wait < 0 ||
      wait > 86_400
    )
      throw new Error("Lock wait must be a whole number from 0 to 86400");
    return {
      scope: "global",
      revision,
      values: {
        defaultTargetBranch: branch(
          values.defaultTargetBranch,
          "Default target branch",
        ),
        lockWaitSeconds: wait,
        conflictResolutionMode: choice(
          values.conflictResolutionMode,
          conflictModes,
          "Conflict resolution",
        ),
        reviewers: participants(values.reviewers, "Default reviewers"),
        assignees: participants(values.assignees, "Default assignees"),
        deliveryPolicyFile: text(
          values.deliveryPolicyFile,
          "Delivery policy file",
        ).trim(),
        harnessCommands: harnessCommands(values.harnessCommands),
      },
    };
  }
  if (request.scope !== "repository") throw new Error("Unknown settings scope");
  exactKeys(
    request,
    ["scope", "revision", "repository", "values"],
    "settings request",
  );
  exactKeys(
    values,
    [
      "enabled",
      "targetBranch",
      "promotion",
      "validationCache",
      "setupCommandPolicy",
      "conflictInstructions",
      "gpgProgram",
    ],
    "repository settings",
  );
  if (typeof values.enabled !== "boolean")
    throw new Error("Enabled must be true or false");
  const promotion = object(values.promotion, "promotion");
  exactKeys(
    promotion,
    ["type", "mode", "productionBranch", "remote", "reviewers", "assignees"],
    "promotion",
  );
  const remote = text(promotion.remote, "Remote", 255).trim();
  if (remote && !isPlausibleBranchName(remote))
    throw new Error(`Remote is not a valid remote name: ${remote}`);
  return {
    scope: "repository",
    revision,
    repository: text(request.repository, "Repository"),
    values: {
      enabled: values.enabled,
      targetBranch: branch(values.targetBranch, "Target branch"),
      promotion: {
        type: choice(promotion.type, ["none", "pull-request"], "Promotion") as
          "none" | "pull-request",
        mode: choice(promotion.mode, promotionModes, "Pull request mode"),
        productionBranch: branch(
          promotion.productionBranch,
          "Production branch",
        ),
        remote,
        reviewers: optionalParticipants(promotion.reviewers, "Reviewers"),
        assignees: optionalParticipants(promotion.assignees, "Assignees"),
      },
      validationCache: choice(
        values.validationCache,
        validationCaches,
        "Validation cache",
      ),
      setupCommandPolicy: choice(
        values.setupCommandPolicy,
        setupPolicies,
        "Setup policy",
      ),
      conflictInstructions: text(
        values.conflictInstructions,
        "Conflict instructions",
        8000,
      ),
      gpgProgram: program(values.gpgProgram, "Signing program"),
    },
  };
}

function setOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | "" | undefined,
): void {
  if (value === "" || value === undefined) delete target[key];
  else target[key] = value as T[K];
}

/**
 * Apply only the settings that differ from the stored values, leaving every
 * other stored field (and the spelling of unchanged ones) intact.
 */
export function applySettings(
  stored: Config,
  request: SettingsRequest,
): Config {
  const next = structuredClone(stored);
  const current = validateConfig(structuredClone(stored), "configuration");
  if (request.scope === "global") {
    const before = globalSettings(current);
    const values = request.values;
    const changed = (key: keyof GlobalSettings) =>
      !isDeepStrictEqual(before[key], values[key]);
    if (changed("defaultTargetBranch"))
      setOptional(next, "defaultTargetBranch", values.defaultTargetBranch);
    if (changed("lockWaitSeconds"))
      next.lockWaitSeconds = values.lockWaitSeconds;
    if (changed("conflictResolutionMode"))
      next.conflictResolutionMode =
        values.conflictResolutionMode as NonNullable<
          Config["conflictResolutionMode"]
        >;
    if (changed("reviewers") || changed("assignees")) {
      const promotion: DefaultPromotionConfig = { ...next.defaultPromotion };
      setOptional(
        promotion,
        "reviewers",
        values.reviewers.length ? values.reviewers : undefined,
      );
      setOptional(
        promotion,
        "assignees",
        values.assignees.length ? values.assignees : undefined,
      );
      setOptional(
        next,
        "defaultPromotion",
        Object.keys(promotion).length ? promotion : undefined,
      );
    }
    if (changed("deliveryPolicyFile"))
      setOptional(next, "deliveryPolicyFile", values.deliveryPolicyFile);
    const commands = { ...next.harnessCommands };
    for (const harness of harnesses) {
      const command = values.harnessCommands[harness];
      if (command === before.harnessCommands[harness]) continue;
      setOptional(commands, harness, command);
      // Keep the legacy alias in step: older coordinators read only it.
      if (harness === "codex" && next.codexCommand !== undefined)
        setOptional(next, "codexCommand", command);
    }
    setOptional(
      next,
      "harnessCommands",
      Object.keys(commands).length ? commands : undefined,
    );
  } else {
    const index = current.repositories.findIndex(
      (repository) => repository.path === request.repository,
    );
    if (index < 0)
      throw new Error(
        `Repository is no longer registered: ${request.repository}`,
      );
    const repository = next.repositories[index]!;
    const before = repositorySettings(current, current.repositories[index]!);
    const values = request.values;
    const changed = (key: keyof RepositorySettings) =>
      !isDeepStrictEqual(before[key], values[key]);
    if (changed("enabled")) {
      const disabled = new Set(next.disabledRepositories ?? []);
      if (values.enabled) disabled.delete(repository.gitCommonDir);
      else disabled.add(repository.gitCommonDir);
      next.disabledRepositories = [...disabled].sort();
    }
    if (changed("targetBranch"))
      setOptional(repository, "targetBranch", values.targetBranch);
    if (changed("promotion")) {
      const p = values.promotion;
      repository.promotion =
        p.type === "none"
          ? { type: "none" }
          : {
              type: "pull-request",
              mode: p.mode as "shared-target" | "session-branch",
              ...(p.productionBranch
                ? { productionBranch: p.productionBranch }
                : {}),
              ...(p.remote ? { remote: p.remote } : {}),
              ...(p.reviewers ? { reviewers: p.reviewers } : {}),
              ...(p.assignees ? { assignees: p.assignees } : {}),
            };
    }
    if (changed("validationCache"))
      repository.validationCache = values.validationCache as NonNullable<
        RepositoryConfig["validationCache"]
      >;
    if (changed("setupCommandPolicy"))
      repository.setupCommandPolicy = values.setupCommandPolicy as NonNullable<
        RepositoryConfig["setupCommandPolicy"]
      >;
    if (changed("conflictInstructions"))
      repository.conflictInstructions = values.conflictInstructions;
    if (changed("gpgProgram"))
      setOptional(repository, "gpgProgram", values.gpgProgram);
    const target =
      repository.targetBranch ??
      next.defaultTargetBranch ??
      repository.defaultBranch;
    if (target === repository.integrationBranch)
      throw new Error(
        `Target branch ${target} must differ from the staging branch ${repository.integrationBranch}`,
      );
  }
  // Reject anything the CLI would refuse to load before it reaches disk.
  validateConfig(structuredClone(next), "updated configuration");
  return next;
}

export async function saveSettings(
  request: SettingsRequest,
): Promise<SettingsView> {
  return withConfigLock(async () => {
    const stored = await readStoredConfig();
    assertCurrent(stored.text, request.revision);
    const next = applySettings(stored.config, request);
    if (stored.text !== null && isDeepStrictEqual(next, stored.config))
      return settingsView(stored.text, stored.config);
    await withRepositoryLocks(
      request.scope === "repository"
        ? stored.config.repositories.filter(
            (r) => r.path === request.repository,
          )
        : [],
      () => writeConfigFile(runtimePaths().config, next, "Dashboard form"),
    );
    const saved = await readStoredConfig();
    return settingsView(saved.text, saved.config);
  });
}

/** Like seshx enable/disable: never change a repository mid-integration. */
async function withRepositoryLocks<T>(
  repositories: RepositoryConfig[],
  action: () => Promise<T>,
): Promise<T> {
  const locks: LockHandle[] = [];
  return withCleanup(
    async () => {
      for (const repository of repositories) {
        const id = repoId(repository.gitCommonDir);
        locks.push(
          await acquireRepoLock(
            id,
            "dashboard-settings",
            0,
            join(runtimePaths().worktrees, id),
            true,
            "change repository settings",
          ),
        );
      }
      return action();
    },
    async () => {
      for (const lock of locks.reverse()) await releaseRepoLock(lock);
    },
  );
}

// The JSON tab edits the whole config.json. It loads the stored text without
// parsing it, so an invalid file can be repaired from the dashboard.
export const maxSettingsJsonLength = 1_048_576;

export interface SettingsJson {
  revision: string;
  configPath: string;
  exists: boolean;
  text: string;
}

export interface SettingsJsonRequest {
  revision: string;
  text: string;
}

function settingsJson(text: string | null): SettingsJson {
  return {
    revision: settingsRevision(text),
    configPath: runtimePaths().config,
    exists: text !== null,
    text: text ?? defaultConfigText(),
  };
}

export async function loadSettingsJson(): Promise<SettingsJson> {
  return settingsJson(await readConfigText());
}

export function parseSettingsJsonRequest(value: unknown): SettingsJsonRequest {
  const request = object(value, "settings request");
  exactKeys(request, ["revision", "text"], "settings request");
  if (
    typeof request.revision !== "string" ||
    !/^[0-9a-f]{64}$/.test(request.revision)
  )
    throw new Error("Invalid settings revision");
  if (
    typeof request.text !== "string" ||
    request.text.length > maxSettingsJsonLength
  )
    throw new Error(
      `Configuration must be text up to ${maxSettingsJsonLength} characters`,
    );
  return { revision: request.revision, text: request.text };
}

/** The stored configuration when the CLI could load it, otherwise `null`. */
function loadableConfig(text: string | null): Config | null {
  if (text === null) return defaultConfig();
  try {
    const config = JSON.parse(text) as Config;
    validateConfig(structuredClone(config), "configuration");
    return config;
  } catch {
    return null;
  }
}

const registration = (r: RepositoryConfig) => `${r.path}\0${r.gitCommonDir}`;

/**
 * Parse edited config.json text. Refuse anything the CLI would refuse to
 * load, and, unless repairing an unloadable file, any added, removed or moved
 * repository: sessions and locks are keyed by those registrations.
 */
export function parseConfigText(text: string, stored: Config | null): Config {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration must be a JSON object");
  const config = value as Config;
  if (
    Array.isArray(config.repositories) &&
    !config.repositories.every(
      (r) =>
        r &&
        typeof r === "object" &&
        !Array.isArray(r) &&
        typeof r.path === "string" &&
        typeof r.gitCommonDir === "string",
    )
  )
    throw new Error(
      "Each repository must be an object with path and gitCommonDir",
    );
  const checked = validateConfig(
    structuredClone(config),
    "edited configuration",
  );
  for (const repository of checked.repositories) {
    const target = targetBranch(repository);
    if (target === repository.integrationBranch)
      throw new Error(
        `Target branch ${target} for ${repository.path} must differ from the staging branch ${repository.integrationBranch}`,
      );
  }
  if (
    stored &&
    !isDeepStrictEqual(
      stored.repositories.map(registration).sort(),
      config.repositories.map(registration).sort(),
    )
  )
    throw new Error(
      "Repositories cannot be added, removed or moved here. Register with seshx register --auto-config; keep each path and gitCommonDir unchanged.",
    );
  return config;
}

export async function saveSettingsJson(
  request: SettingsJsonRequest,
): Promise<SettingsJson> {
  return withConfigLock(async () => {
    const text = await readConfigText();
    assertCurrent(text, request.revision);
    const stored = loadableConfig(text);
    const next = parseConfigText(request.text, stored);
    if (text !== null && stored && isDeepStrictEqual(next, stored))
      return settingsJson(text);
    const disabled = (config: Config, r: RepositoryConfig) =>
      (config.disabledRepositories ?? []).includes(r.gitCommonDir);
    // Lock every repository whose entry or enablement changes; all of them
    // when repairing, since the previous values are unknown.
    const changed = next.repositories.filter((repository) => {
      const before = stored?.repositories.find(
        (r) => registration(r) === registration(repository),
      );
      return (
        !stored ||
        !isDeepStrictEqual(before, repository) ||
        disabled(stored, repository) !== disabled(next, repository)
      );
    });
    await withRepositoryLocks(changed, () =>
      writeConfigFile(runtimePaths().config, next, "Dashboard JSON"),
    );
    return settingsJson(await readConfigText());
  });
}

/** Earlier config.json versions, newest first, without their text. */
export async function loadSettingsHistory(): Promise<{
  limit: number;
  entries: ConfigSnapshotSummary[];
}> {
  return {
    limit: configHistoryLimit,
    entries: await listConfigHistory(runtimePaths().config),
  };
}

/** Read-only suggestions for the Settings form fields. */
export async function loadSettingsSuggestions(): Promise<SettingsSuggestions> {
  const stored = await readStoredConfig();
  return settingsSuggestions(
    validateConfig(structuredClone(stored.config), runtimePaths().config),
  );
}

export async function loadSettingsSnapshot(
  id: string,
): Promise<ConfigSnapshot> {
  return readConfigSnapshot(runtimePaths().config, id);
}
