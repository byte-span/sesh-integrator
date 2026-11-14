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
  state: SkillState;
  installedVersion: string | undefined;
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
export declare function installSkill(options: {
  source: string;
  name: string;
  targetDir: string;
  owner: string;
  version: string;
  command: string;
}): { dest: string; hash: string };
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
