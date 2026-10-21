import type {
  Command,
  RepositoryConfig,
  ValidationCommand,
  ValidationStep,
  ValidationTier,
} from "./types.js";

export interface SelectedValidation {
  name: string;
  changedPaths: string[];
  sourceCommands: ValidationStep[];
  integrationCommands: ValidationStep[];
  bypassIntegrationWorktree: boolean;
  /** The selected tier's commands run without a build queue slot. */
  bypassBuildQueue: boolean;
}

/**
 * Why a selected plan's commands skip the build queue, or undefined when they
 * queue. Only an explicitly marked tier bypasses; the full fallback never does.
 */
export function validationQueueBypass(
  validation: Pick<SelectedValidation, "name" | "bypassBuildQueue">,
): string | undefined {
  return validation.bypassBuildQueue
    ? `lightweight validation tier ${validation.name}`
    : undefined;
}

/** Why setup commands skip the build queue, or undefined when they queue. */
export function setupQueueBypass(
  repository: Pick<RepositoryConfig, "setupBypassBuildQueue">,
): string | undefined {
  return repository.setupBypassBuildQueue === true
    ? "lightweight setup commands"
    : undefined;
}

/**
 * Reject non-boolean queue bypass options. Unknown values must never silently
 * bypass or silently queue, so a typo stops every command with this message.
 */
export function queueBypassConfigError(
  repository: RepositoryConfig,
): string | undefined {
  if (
    repository.setupBypassBuildQueue !== undefined &&
    typeof repository.setupBypassBuildQueue !== "boolean"
  )
    return `Invalid setupBypassBuildQueue for ${repository.path}: use true or false`;
  for (const tier of repository.validationTiers ?? [])
    if (
      tier.bypassBuildQueue !== undefined &&
      typeof tier.bypassBuildQueue !== "boolean"
    )
      return `Invalid bypassBuildQueue in validation tier ${tier.name} for ${repository.path}: use true or false`;
  return undefined;
}

export function isValidationStepList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((step) => {
      if (isValidationCommand(step)) return true;
      if (typeof step !== "object" || step === null || !("parallel" in step)) {
        return false;
      }
      const parallel = (step as { parallel?: unknown }).parallel;
      return (
        Array.isArray(parallel) &&
        parallel.length > 0 &&
        parallel.every(isValidationCommand)
      );
    })
  );
}

/**
 * The first tier, in configuration order, whose patterns match every path.
 * This is the single precedence rule for selecting a tier from paths.
 */
export function findValidationTier(
  repository: RepositoryConfig,
  paths: string[],
): ValidationTier | undefined {
  return (repository.validationTiers ?? []).find(
    (candidate) =>
      paths.length > 0 &&
      paths.every((path) =>
        candidate.paths.some((pattern) => matchesPath(pattern, path)),
      ),
  );
}

export function selectValidation(
  repository: RepositoryConfig,
  paths: string[],
  allowTiers = true,
): SelectedValidation {
  const tier = allowTiers ? findValidationTier(repository, paths) : undefined;
  return tier
    ? selectedTier(tier, paths)
    : {
        name: "full",
        changedPaths: paths,
        sourceCommands: repository.sourceValidationCommands,
        integrationCommands: repository.integrationValidationCommands,
        bypassIntegrationWorktree: false,
        bypassBuildQueue: false,
      };
}

function selectedTier(
  tier: ValidationTier,
  paths: string[],
): SelectedValidation {
  return {
    name: tier.name,
    changedPaths: paths,
    sourceCommands: tier.sourceValidationCommands,
    integrationCommands: tier.integrationValidationCommands,
    bypassIntegrationWorktree: tier.bypassIntegrationWorktree === true,
    bypassBuildQueue: tier.bypassBuildQueue === true,
  };
}

function matchesPath(pattern: string, path: string): boolean {
  const normalizedPattern = pattern.replaceAll("\\", "/");
  const normalizedPath = path.replaceAll("\\", "/");
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]!;
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      index += 1;
      if (normalizedPattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(normalizedPath);
}

export function validationCommandValue(value: ValidationCommand): Command {
  return Array.isArray(value) ? value : value.command;
}

function isValidationCommand(value: unknown): boolean {
  if (isCommand(value)) return true;
  if (typeof value !== "object" || value === null || !("command" in value)) {
    return false;
  }
  const spec = value as Record<string, unknown>;
  if (!isCommand(spec.command)) return false;
  if (spec.resources !== undefined && !isResources(spec.resources))
    return false;
  if (spec.failure !== undefined && !isFailurePolicy(spec.failure))
    return false;
  return true;
}

function isCommand(value: unknown): value is Command {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string" && part.length > 0)
  );
}

function isResources(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const resources = value as { shared?: unknown; exclusive?: unknown };
  return (
    isKeyList(resources.shared) &&
    isKeyList(resources.exclusive) &&
    !((resources.shared as string[] | undefined) ?? []).some((key) =>
      ((resources.exclusive as string[] | undefined) ?? []).includes(key),
    )
  );
}

function isKeyList(value: unknown): value is string[] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((key) => typeof key === "string" && key.trim().length > 0))
  );
}

function isFailurePolicy(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Record<string, unknown>;
  if (
    policy.classification !== undefined &&
    !["transient", "deterministic"].includes(String(policy.classification))
  )
    return false;
  for (const key of ["maxAttempts", "initialBackoffMs", "maxBackoffMs"]) {
    const item = policy[key];
    if (
      item !== undefined &&
      (!Number.isInteger(item) ||
        Number(item) < (key === "maxAttempts" ? 1 : 0))
    )
      return false;
  }
  return true;
}
