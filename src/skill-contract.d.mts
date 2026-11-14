// Types for skill-contract.mjs, the shared agent skill install contract.
// The .mjs file stays a verbatim copy of the reference implementation, so it
// is typed here instead of being ported. Keep these in step with it.

export declare const CONTRACT: string;
export declare const HARNESS_LIST_VERSION: string;
export declare const MANAGED_KEYS: string[];

export type SkillState =
  | "missing"
  | "current"
  | "stale"
  | "legacy"
  | "unmanaged"
  | "other-owner"
  | "edited";

/**
 * A syncSkill row also reports "busy" (heal found another process holding the
 * per-skill lock, or install waited past its limit) and "error" (an
 * unexpected failure, with the message in `error`).
 */
export type SyncState = SkillState | "busy" | "error";

export interface SkillTarget {
  id: string;
  harnesses: string[];
  dir: string;
  detect: string[];
}

export interface TargetOptions {
  home?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export interface SkillStamp {
  by?: string;
  version?: string;
  command?: string;
  hash?: string;
}

export interface SyncRow {
  target: string;
  harnesses: string[];
  dest: string;
  state: SyncState;
  installedVersion?: string | undefined;
  changed: boolean;
  error?: string;
}

export declare function skillTargets(options?: TargetOptions): SkillTarget[];
export declare function activeTargets(options?: TargetOptions): SkillTarget[];
export declare function stamp(
  text: string,
  meta: { by: string; version: string; command: string; hash: string },
): string;
export declare function unstamp(text: string): string;
export declare function readStamp(skillDir: string): SkillStamp | null;
export declare function hashSkill(skillDir: string): string;
export declare function classify(
  installedDir: string,
  options: {
    owner: string;
    bundledHash?: string | undefined;
    legacyHashes?: readonly string[] | undefined;
  },
): SkillState;
export interface InstallSkillOptions {
  source: string;
  name: string;
  targetDir: string;
  owner: string;
  version: string;
  command: string;
}

/** Waits for the per-skill lock; throws if it stays held. */
export declare function installSkill(options: InstallSkillOptions): {
  dest: string;
  hash: string;
};
/**
 * Locked backup-then-install, for explicit replace flags only. backupDir must
 * be outside every skills directory and must not exist yet. `backup` is null
 * when there was no copy to back up.
 */
export declare function replaceSkill(
  options: InstallSkillOptions & { backupDir: string },
): { dest: string; hash: string; backup: string | null };
/** Waits for the per-skill lock; throws if it stays held. */
export declare function removeSkill(options: {
  name: string;
  targetDir: string;
  owner: string;
  bundledHash?: string | undefined;
  legacyHashes?: readonly string[] | undefined;
}): { dest: string; state: SkillState; removed: boolean };
export declare function compareVersions(a: unknown, b: unknown): number;
export declare function syncSkill(
  options: {
    source: string;
    name: string;
    owner: string;
    version: string;
    command: string;
    legacyHashes?: readonly string[] | undefined;
    mode?: "install" | "heal" | "status";
    allowDowngrade?: boolean;
  } & TargetOptions,
): SyncRow[];
