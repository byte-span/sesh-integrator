import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeTargets,
  classify,
  compareVersions,
  hashSkill,
  installSkill,
  readStamp,
  removeSkill,
  skillTargets,
  syncSkill,
  type SkillState,
  type SkillTarget,
  type SyncRow,
} from "./skill-contract.mjs";
import { runtimePaths } from "./runtime.js";

export const SKILL_NAME = "sesh-integrator-workflow";
export const SKILL_OWNER = "sesh-integrator";
export const SKILL_COMMAND = "seshx";

/**
 * hashSkill() of every skill folder that pre-contract installers wrote, so
 * those unstamped copies are adopted. Computed from every commit of
 * skill/sesh-integrator-workflow since the 814d8a4 rename: each SKILL.md alone
 * (Claude, Antigravity, Grok, Gemini) and with agents/openai.yaml (Codex).
 * Contract installs are stamped, so later versions never need adding here.
 */
export const LEGACY_SKILL_HASHES: readonly string[] = [
  "sha256:ee0400d572332c1a57d207a67d60d298c3af6f2bcc8fef4ea2291ad50c6cdfa4",
  "sha256:a22ba9d4cc5a9cf1e82138668209e4cddb6b3c2e8dca9d753a4e01b519e573fb",
  "sha256:abd14d1f9e084dfd7f0092ad10448c3692ac9e142e807b991a615c47288f515c",
  "sha256:3e2ee62623e695edff2e5919845100aaafce2342a232549e4a1b98df789d15ff",
  "sha256:79ded08ec109a450be7fe3e43841d90bdcffd978825d5f9935fd60bbdae18126",
  "sha256:5cbd22891e9bb84832613911879af6fc7d8c4950ad092a4238b0d1ce7bfd7826",
  "sha256:67274961761587123f0e1d0a54f939b4153b29f3b0474496f8e1ae3bc3664e27",
  "sha256:40c48a2df6bde553dc74935d516a0b0505897b3c4d4b2e984ccea52b8ac4d553",
  "sha256:e8b9261460fd3c587aabae111ec322c004f74751d43a1a898e3c587cda5a1e3d",
  "sha256:550e5e419b4c2f3d499d21f5ccf1aa57871494bf9ef64f0f26b64fe4fa01f15b",
  "sha256:25530239e2b9d6524b96d67bf9af9ca8c6b26d25a62120daf9166b252fdffd3f",
  "sha256:e1236a5762f87ee39a944344bd308bd9f04ddd1fbeee224c3f803489fe4cf714",
  "sha256:b1df267269d96e1db53e0f0d71da29ecc33a5b23b200dd642a3a9d4f17d52e9d",
  "sha256:240cde26f94039935ca55a98c1161c5356ade5f03f34f8be6bad782b69b37af5",
  "sha256:d5f1db519a555f8d80c10350fbfeb40243f678753bf10e26889a58eb64f45d82",
  "sha256:c499bc6a146740e1d329ec0e48e7ebbafd195bf7ec48bb548818e104cbeaa78a",
  "sha256:708a08684c41ac1d3a926b9cd3cd7a13897d10a2d68e425024d1c22ea82140e9",
  "sha256:31cec388ee353eec365cbdb2b229eeddd0b25d29ee4b6481ec4cfdad6af4ade9",
  "sha256:468820a3ac73c01dc644449cff03c835f3cb7b1d7ba3eaec66d7dde4b73ff388",
  "sha256:f4fe470814ccc015dbb2543db34eaeced61eb10f6fd9502c6884a6e190b4aaea",
  "sha256:39c0373c17e81d7a4c562d7f2abd61d3f901decd32d15a6028867be90562bcd6",
  "sha256:651fa95a95b8cc63e5118267b0e0a7ffff8b613e670dbf361d3270a2ff34ade3",
  "sha256:0d7c950164c5239b41255649a04b72e2188a948ea8fe2cad1e45b5767e0ab317",
  "sha256:179de2b49b6ab3467cac21367b6f69405d754d100e3c2cd6b87b0d6f4a9726b5",
  "sha256:c8378e1d076445217c0ee2adfd76cf9ee8edd4845359741ca3744f8fa49cf7c2",
  "sha256:303be5230895bb351053fdd7cee560e15668eb05cd78e0125386ec37a5f25c26",
  "sha256:a7d5f5a30be7fff17f92da4a31246761a76c362bdd8807583f6ff56059ea8190",
  "sha256:ca66a660b62869cc91747c1f0d5692352ab2d60834f0e938450c224f7774a964",
  "sha256:fb3c6d5449c258af1239a350522ce583db9dd8a8323c9034c408ad6195ecaa05",
  "sha256:21d253fc317cb684c90d6642bd3fcdc9a1742e02a837b016e6fc2f3defd4cb19",
];

export interface SkillScope {
  home?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface SkillRow {
  target: string;
  harnesses: string[];
  dest: string;
  state: SkillState;
  installedVersion: string | null;
}

export interface SkillChange extends SkillRow {
  changed: boolean;
  backup?: string;
  error?: string;
  /** Left alone in a state the caller must resolve (flag or other tool). */
  blocked: boolean;
  note: string;
}

/** Absolute path of the bundled source folder (`seshx skill path`). */
export function skillSource(): string {
  return fileURLToPath(new URL(`../skill/${SKILL_NAME}`, import.meta.url));
}

let packageVersion: string | undefined;
/** managed-version: the package version, bumped whenever the skill changes. */
export function skillVersion(): string {
  packageVersion ??= (
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string }
  ).version;
  return packageVersion;
}

function contractOptions(scope: SkillScope) {
  return {
    source: skillSource(),
    name: SKILL_NAME,
    owner: SKILL_OWNER,
    version: skillVersion(),
    command: SKILL_COMMAND,
    legacyHashes: LEGACY_SKILL_HASHES,
    home: scope.home,
    env: scope.env,
  };
}

function row(
  target: Pick<SyncRow, "target" | "harnesses" | "dest">,
  state: SkillState,
): SkillRow {
  return {
    target: target.target,
    harnesses: target.harnesses,
    dest: target.dest,
    state,
    installedVersion: readStamp(target.dest)?.version ?? null,
  };
}

const targetRow = (target: SkillTarget) => ({
  target: target.id,
  harnesses: target.harnesses,
  dest: join(target.dir, SKILL_NAME),
});

/** One row per active target; changes nothing. */
export function skillStatus(scope: SkillScope = {}): SkillRow[] {
  return syncSkill({ ...contractOptions(scope), mode: "status" }).map(
    (result) => row(result, result.state),
  );
}

/** State of one target, active or not (setup checks selected harnesses). */
export function skillTargetStatus(
  id: string,
  scope: SkillScope = {},
): (SkillRow & { owner: string | undefined }) | undefined {
  const target = skillTargets(scope).find((candidate) => candidate.id === id);
  if (!target) return undefined;
  const dest = join(target.dir, SKILL_NAME);
  const state = classify(dest, {
    owner: SKILL_OWNER,
    bundledHash: hashSkill(skillSource()),
    legacyHashes: LEGACY_SKILL_HASHES,
  });
  return { ...row(targetRow(target), state), owner: readStamp(dest)?.by };
}

export interface InstallOptions extends SkillScope {
  replaceUnmanaged?: boolean;
  replaceEdited?: boolean;
  allowDowngrade?: boolean;
  /** Targets to create first so they count as active (explicit setup). */
  ensureTargets?: readonly string[];
}

/** Whether an install run with these options would write this row. */
export function installWouldChange(
  current: SkillRow,
  options: InstallOptions = {},
): boolean {
  switch (current.state) {
    case "missing":
    case "legacy":
      return true;
    case "stale":
      return (
        options.allowDowngrade === true ||
        compareVersions(skillVersion(), current.installedVersion) >= 0
      );
    case "unmanaged":
      return options.replaceUnmanaged === true;
    case "edited":
      return options.replaceEdited === true;
    default:
      return false;
  }
}

/** `seshx skill install`: contract install over every active target. */
export function installWorkflowSkill(
  options: InstallOptions = {},
): SkillChange[] {
  const scope = { home: options.home, env: options.env };
  for (const id of options.ensureTargets ?? []) {
    const target = skillTargets(scope).find((t) => t.id === id);
    if (target) mkdirSync(target.dir, { recursive: true });
  }
  const before = new Map(skillStatus(scope).map((r) => [r.target, r]));
  const backups = new Map<string, string>();
  const failures = new Map<string, string>();
  for (const current of before.values()) {
    if (
      (current.state === "unmanaged" || current.state === "edited") &&
      installWouldChange(current, options)
    ) {
      try {
        backups.set(current.target, backupSkill(current.dest));
      } catch (error) {
        failures.set(current.target, errorMessage(error));
      }
    }
  }
  const rows = syncSkill({
    ...contractOptions(scope),
    mode: "install",
    allowDowngrade: options.allowDowngrade === true,
  });
  return rows.map((result) => {
    const previous = before.get(result.target)!;
    const error = failures.get(result.target) ?? result.error;
    const after = row(result, result.changed ? "current" : result.state);
    const backup = backups.get(result.target);
    const change: SkillChange = {
      ...after,
      changed: result.changed,
      ...(backup ? { backup } : {}),
      ...(error ? { error } : {}),
      blocked: false,
      note: "",
    };
    change.note = describeInstall(change, previous);
    change.blocked =
      Boolean(error) ||
      ["unmanaged", "edited", "other-owner"].includes(after.state);
    return change;
  });
}

function describeInstall(change: SkillChange, previous: SkillRow): string {
  const version = skillVersion();
  if (change.error) return `failed: ${change.error}`;
  if (change.changed)
    switch (previous.state) {
      case "missing":
        return `installed ${version}`;
      case "legacy":
        return `adopted the copy from an earlier seshx; now ${version}`;
      case "stale":
        return `updated ${previous.installedVersion ?? "?"} -> ${version}`;
      default:
        return `replaced the ${previous.state} copy (backup: ${change.backup}); now ${version}`;
    }
  switch (change.state) {
    case "current":
      return `current (${change.installedVersion ?? version})`;
    case "stale":
      return `left newer version ${change.installedVersion ?? "?"}; rerun with --allow-downgrade to replace it with ${version}`;
    case "unmanaged":
      return "left a copy seshx did not install; rerun with --replace-unmanaged to back it up and replace it";
    case "edited":
      return "left a locally edited copy; rerun with --replace-edited to back it up and replace it";
    case "other-owner":
      return `left a copy managed by ${readStamp(change.dest)?.by ?? "another tool"}`;
    default:
      return change.state;
  }
}

/** Move a copy to <state dir>/skill-backups/<name>-<UTC timestamp>/. */
function backupSkill(dest: string): string {
  const root = join(runtimePaths().root, "skill-backups");
  mkdirSync(root, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  let backup = join(root, `${SKILL_NAME}-${stamp}`);
  for (let suffix = 2; existsSync(backup); suffix += 1)
    backup = join(root, `${SKILL_NAME}-${stamp}-${suffix}`);
  try {
    renameSync(dest, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(dest, backup, { recursive: true, verbatimSymlinks: true });
    rmSync(dest, { recursive: true, force: true });
  }
  return backup;
}

export interface RemoveResult extends SkillRow {
  removed: boolean;
}

/** Remove owned copies (current, stale or legacy) from active targets. */
export function removeWorkflowSkill(
  options: SkillScope & { targets?: readonly string[] } = {},
): RemoveResult[] {
  const scope = { home: options.home, env: options.env };
  const bundledHash = hashSkill(skillSource());
  return activeTargets(scope)
    .filter((target) => !options.targets || options.targets.includes(target.id))
    .map((target) => {
      const before = row(targetRow(target), "missing");
      const result = removeSkill({
        name: SKILL_NAME,
        targetDir: target.dir,
        owner: SKILL_OWNER,
        bundledHash,
        legacyHashes: LEGACY_SKILL_HASHES,
      });
      return {
        ...before,
        state: result.state,
        removed: result.removed,
      };
    });
}

/** Install the skill at an explicit folder (legacy install-skill.sh <dir>). */
export function installWorkflowSkillAt(dest: string): SkillChange {
  const state = classify(dest, {
    owner: SKILL_OWNER,
    bundledHash: hashSkill(skillSource()),
    legacyHashes: LEGACY_SKILL_HASHES,
  });
  const before: SkillRow = {
    target: "custom",
    harnesses: [],
    dest,
    state,
    installedVersion: readStamp(dest)?.version ?? null,
  };
  const update =
    state === "missing" ||
    state === "legacy" ||
    (state === "stale" && installWouldChange(before));
  if (update)
    installSkill({
      source: skillSource(),
      name: basename(dest),
      targetDir: dirname(dest),
      owner: SKILL_OWNER,
      version: skillVersion(),
      command: SKILL_COMMAND,
    });
  const change: SkillChange = {
    ...before,
    state: update ? "current" : state,
    installedVersion: update ? skillVersion() : before.installedVersion,
    changed: update,
    blocked: !update && state !== "current" && state !== "stale",
    note: "",
  };
  change.note = describeInstall(change, before);
  return change;
}

/**
 * Heal on normal runs: update legacy copies and copies an older seshx
 * installed. Never adds a missing copy and never downgrades, so pinned older
 * coordinators cannot flip-flop it. Never fails or prints unless it changed
 * something. AGENT_SKILL_HEAL=0 disables it.
 */
export function healWorkflowSkill(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AGENT_SKILL_HEAL === "0") return;
  try {
    // Fast path for the usual case. Heal only changes an unstamped copy (it
    // may be legacy) or our own copy stamped with an older version, so skip
    // hashing anything when no detected copy is either.
    const version = skillVersion();
    const mayChange = activeTargets({ env }).some((target) => {
      const stamp = readStamp(join(target.dir, SKILL_NAME));
      if (stamp === null) return false;
      if (!stamp.by) return true;
      return (
        stamp.by === SKILL_OWNER && compareVersions(version, stamp.version) > 0
      );
    });
    if (!mayChange) return;
    const changed = syncSkill({ ...contractOptions({ env }), mode: "heal" })
      .filter((result) => result.changed)
      .map((result) => result.target);
    if (changed.length)
      process.stderr.write(
        `seshx: updated the ${SKILL_NAME} skill to ${skillVersion()} (${changed.join(", ")}); AGENT_SKILL_HEAL=0 disables this\n`,
      );
  } catch {
    // Healing is best effort; it must never affect the command.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const usage =
  "Usage: seshx skill install [--replace-unmanaged] [--replace-edited] [--allow-downgrade] | status [--json] | remove | path";

function flags(args: string[], allowed: string[]): Set<string> {
  for (const arg of args)
    if (!allowed.includes(arg))
      throw new Error(`Unknown skill option: ${arg}\n${usage}`);
  return new Set(args);
}

function line(target: string, harnesses: string[], text: string): string {
  return `${target.padEnd(22)} ${harnesses.join(", ").padEnd(40)} ${text}\n`;
}

const noTargets =
  "No supported harness directory found; install a coding harness first. Checked: ";

/** `seshx skill install|status|remove|path`. */
export async function skillCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  switch (action) {
    case "path":
      flags(rest, []);
      process.stdout.write(`${skillSource()}\n`);
      return;
    case "status": {
      const json = flags(rest, ["--json"]).has("--json");
      const rows = skillStatus();
      if (json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      if (!rows.length) {
        process.stdout.write(`${noTargets}${checked()}\n`);
        return;
      }
      for (const r of rows)
        process.stdout.write(
          line(
            r.target,
            r.harnesses,
            `${r.state.padEnd(11)} ${(r.installedVersion ?? "-").padEnd(9)} ${r.dest}`,
          ),
        );
      return;
    }
    case "install": {
      const options = flags(rest, [
        "--replace-unmanaged",
        "--replace-edited",
        "--allow-downgrade",
      ]);
      const rows = installWorkflowSkill({
        replaceUnmanaged: options.has("--replace-unmanaged"),
        replaceEdited: options.has("--replace-edited"),
        allowDowngrade: options.has("--allow-downgrade"),
      });
      printInstall(rows);
      if (!rows.length || rows.some((r) => r.blocked)) process.exitCode = 1;
      return;
    }
    case "remove": {
      flags(rest, []);
      const rows = removeWorkflowSkill();
      if (!rows.length) process.stdout.write(`${noTargets}${checked()}\n`);
      for (const r of rows)
        process.stdout.write(
          line(
            r.target,
            r.harnesses,
            r.removed
              ? `removed (${r.state})`
              : r.state === "missing"
                ? "not installed"
                : `left the ${r.state} copy at ${r.dest}`,
          ),
        );
      return;
    }
    default:
      throw new Error(usage);
  }
}

/** Print install rows; shared with setup. */
export function printInstall(rows: SkillChange[]): void {
  if (!rows.length) process.stdout.write(`${noTargets}${checked()}\n`);
  for (const r of rows)
    process.stdout.write(line(r.target, r.harnesses, r.note));
}

function checked(): string {
  return skillTargets()
    .map((target) => target.dir)
    .join(", ");
}
