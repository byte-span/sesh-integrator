import type {
  RepositoryConfig,
  ValidationStep,
  ValidationTier,
} from "./types.js";

export interface SelectedValidation {
  name: string;
  changedPaths: string[];
  sourceCommands: ValidationStep[];
  integrationCommands: ValidationStep[];
  bypassIntegrationWorktree: boolean;
}

export function isValidationStepList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((step) => {
      if (isCommand(step)) return true;
      if (typeof step !== "object" || step === null || !("parallel" in step)) {
        return false;
      }
      const parallel = (step as { parallel?: unknown }).parallel;
      return (
        Array.isArray(parallel) &&
        parallel.length > 0 &&
        parallel.every(isCommand)
      );
    })
  );
}

export function selectValidation(
  repository: RepositoryConfig,
  paths: string[],
  allowTiers = true,
): SelectedValidation {
  const tier = allowTiers
    ? (repository.validationTiers ?? []).find(
        (candidate) =>
          paths.length > 0 &&
          paths.every((path) =>
            candidate.paths.some((pattern) => matchesPath(pattern, path)),
          ),
      )
    : undefined;
  return tier
    ? selectedTier(tier, paths)
    : {
        name: "full",
        changedPaths: paths,
        sourceCommands: repository.sourceValidationCommands,
        integrationCommands: repository.integrationValidationCommands,
        bypassIntegrationWorktree: false,
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

function isCommand(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string" && part.length > 0)
  );
}
