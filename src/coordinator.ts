import { withCleanup } from "./file-lock.js";
import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSessions, runtimePaths, writeJsonAtomic } from "./runtime.js";
import { inspectGit } from "./git.js";
import type { CoordinatorIdentity, Session } from "./types.js";

// Bump when a writer introduces state that earlier contract readers cannot recover.
export const STATE_CONTRACT = 1;
/**
 * Contract recorded only on sessions that carry a delivery rule. Coordinators
 * that predate delivery policies would ignore the rule, so they must refuse
 * these sessions; this build accepts both contracts.
 */
export const DELIVERY_STATE_CONTRACT = 2;
const SUPPORTED_STATE_CONTRACTS: readonly number[] = [
  STATE_CONTRACT,
  DELIVERY_STATE_CONTRACT,
];
const assets = [
  "dist",
  "skill",
  "scripts",
  "systemd",
  "package.json",
  "harnesses.json",
  "GLOBAL_AGENTS_SNIPPET.md",
];
const project = fileURLToPath(new URL("../", import.meta.url));
/** Terminal statuses: integrated, finished without changes, or abandoned. */
export const terminalStatuses: readonly Session["status"][] = [
  "succeeded",
  "no_changes",
  "abandoned",
];
export const unfinished = (s: Session): boolean =>
  !terminalStatuses.includes(s.status);

export function assertCompatible(s: Session): void {
  if (
    s.coordinator &&
    (!SUPPORTED_STATE_CONTRACTS.includes(s.coordinator.stateContract) ||
      s.coordinator.recoveryContract !== 1)
  )
    throw new Error(
      `Incompatible session ${s.id}; no mutation performed. Use its recorded coordinator ${s.coordinator.cliPath}. If missing, reinstall a build supporting state contract ${s.coordinator.stateContract} and recovery contract ${s.coordinator.recoveryContract}. Preserve the runtime and Git recovery refs.`,
    );
  if (s.recoveryBundle && s.recoveryBundle.version !== 1)
    throw new Error(
      `Incompatible recovery bundle for ${s.id}; use the original coordinator or a compatible reinstall. Preserve runtime data.`,
    );
}
export async function preflightRuntimeCompatibility(scope?: {
  sessionId?: string;
  cwd: string;
}): Promise<void> {
  const worktree =
    scope && !scope.sessionId
      ? (await inspectGit(scope.cwd)).worktreePath
      : undefined;
  for (const s of await readSessions(true))
    if (
      unfinished(s) &&
      (!scope ||
        (scope.sessionId
          ? s.id === scope.sessionId
          : s.worktreePath === worktree || s.launchWorktreePath === worktree))
    ) {
      assertCompatible(s);
      if (s.recoveryBundle) {
        const manifest = JSON.parse(
          await readFile(join(s.recoveryBundle.path, "manifest.json"), "utf8"),
        );
        if (manifest.version !== 1)
          throw new Error(
            `Incompatible recovery manifest for ${s.id}; reinstall its recorded coordinator before mutation`,
          );
      }
    }
}
async function digest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const bytes = await readFile(join(root, name));
        hash.update(name + "\0" + bytes.length + "\0");
        hash.update(bytes);
      } else
        throw new Error(`Coordinator asset is not a regular file: ${name}`);
    }
  }
  for (const name of assets) {
    if (["dist", "skill", "scripts", "systemd"].includes(name))
      await walk(name);
    else {
      const bytes = await readFile(join(root, name));
      hash.update(name + "\0" + bytes.length + "\0");
      hash.update(bytes);
    }
  }
  return hash.digest("hex");
}
export async function retainCoordinator(): Promise<CoordinatorIdentity> {
  const buildId = await digest(project);
  const root = join(runtimePaths().root, "coordinators");
  let destination = join(root, buildId);
  await mkdir(root, { recursive: true });
  try {
    if ((await digest(destination)) !== buildId) {
      destination = join(
        root,
        `${buildId}-repair-${randomBytes(5).toString("hex")}`,
      );
      const missing = new Error(
        "Retain damaged copy and install an independent replacement",
      ) as NodeJS.ErrnoException;
      missing.code = "ENOENT";
      throw missing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await readdir(destination);
      destination = join(
        root,
        `${buildId}-repair-${randomBytes(5).toString("hex")}`,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const temp = await mkdtemp(join(root, ".install-"));
    await withCleanup(
      async () => {
        for (const name of assets)
          await cp(join(project, name), join(temp, name), { recursive: true });
        if ((await digest(temp)) !== buildId)
          throw new Error(
            "Coordinator changed during snapshot; retry with a stable build",
          );
        try {
          await rename(temp, destination);
        } catch (e) {
          if (
            !["EEXIST", "ENOTEMPTY"].includes(
              (e as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw e;
          if ((await digest(destination)) !== buildId)
            throw new Error("Concurrent coordinator snapshot mismatch");
        }
      },
      async () => {
        try {
          await rm(temp, { recursive: true, force: true });
        } catch (error) {
          throw new Error(
            `Coordinator snapshot cleanup at ${temp} failed; preserve this artifact for inspection: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      },
      "Coordinator snapshot cleanup",
    );
  }
  const pkg = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  ) as { version: string };
  return {
    buildId,
    version: pkg.version,
    stateContract: STATE_CONTRACT,
    recoveryContract: 1,
    cliPath: join(destination, "dist/cli.js"),
  };
}
export type CoordinatorHealth = "legacy" | "intact" | "modified" | "missing";

/** Read-only check of a session's pinned coordinator snapshot. */
export async function coordinatorHealth(
  s: Session,
): Promise<CoordinatorHealth> {
  if (!s.coordinator) return "legacy";
  try {
    const root = dirname(dirname(await realpath(s.coordinator.cliPath)));
    return (await digest(root)) === s.coordinator.buildId
      ? "intact"
      : "modified";
  } catch {
    return "missing";
  }
}

export async function coordinatorDescription(s: Session): Promise<string> {
  const health = await coordinatorHealth(s);
  if (!s.coordinator || health === "legacy")
    return "legacy (no build identity); compatible recovery imports preserved state";
  if (health === "modified")
    return `MODIFIED ${s.coordinator.cliPath}; reinstall a compatible build before recovery`;
  if (health === "missing")
    return `MISSING ${s.coordinator.cliPath}; compatible reinstall can recover contract ${s.coordinator.stateContract}`;
  return `${s.coordinator.buildId} (contract ${s.coordinator.stateContract}) ${s.coordinator.cliPath}`;
}
export async function enrollmentStopped(harness: string): Promise<boolean> {
  try {
    return JSON.parse(
      await readFile(join(runtimePaths().root, "enrollment.json"), "utf8"),
    ).stoppedHarnesses.includes(harness);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function setEnrollment(
  harnesses: string[],
  stopped: boolean,
): Promise<void> {
  const all = ["codex", "claude", "antigravity", "gemini", "grok"];
  const disabled = [];
  for (const h of all)
    if (harnesses.includes(h) ? stopped : await enrollmentStopped(h))
      disabled.push(h);
  await writeJsonAtomic(join(runtimePaths().root, "enrollment.json"), {
    stoppedHarnesses: disabled,
  });
}
