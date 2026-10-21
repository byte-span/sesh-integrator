import type {
  Config,
  IntegrationBatchingConfig,
  RepositoryConfig,
} from "./types.js";

/** Sessions merged into one batch candidate by default, including its leader. */
export const DEFAULT_BATCH_MAX_SESSIONS = 8;
export const MAX_BATCH_MAX_SESSIONS = 64;

export interface IntegrationBatchingSettings {
  enabled: boolean;
  maxSessions: number;
}

/** Repository settings override the global defaults, key by key. */
export function integrationBatchingSettings(
  config: Pick<Config, "integrationBatching">,
  repository: Pick<RepositoryConfig, "integrationBatching">,
): IntegrationBatchingSettings {
  return {
    enabled:
      repository.integrationBatching?.enabled ??
      config.integrationBatching?.enabled ??
      true,
    maxSessions:
      repository.integrationBatching?.maxSessions ??
      config.integrationBatching?.maxSessions ??
      DEFAULT_BATCH_MAX_SESSIONS,
  };
}

/** Undefined is valid; unknown keys are rejected to catch misspellings. */
export function isIntegrationBatchingConfig(
  value: unknown,
): value is IntegrationBatchingConfig | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["enabled", "maxSessions"].includes(key))
  )
    return false;
  if (record.enabled !== undefined && typeof record.enabled !== "boolean")
    return false;
  return (
    record.maxSessions === undefined ||
    (Number.isInteger(record.maxSessions) &&
      (record.maxSessions as number) >= 1 &&
      (record.maxSessions as number) <= MAX_BATCH_MAX_SESSIONS)
  );
}
