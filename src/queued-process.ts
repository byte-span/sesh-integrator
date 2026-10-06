import { spawn } from "node:child_process";
import { acquireBuildSlot, releaseBuildSlot } from "./build-queue.js";
import { withCleanup } from "./file-lock.js";
import { spawnFailure } from "./execution-error.js";
import { recordSubprocess } from "./performance.js";
import type { CommandResult } from "./types.js";

// One handler per process even for large parallel groups. The abort stays sticky
// until all siblings finish, so cancellation cannot turn into a transient retry.
let cancellation:
  | { controller: AbortController; users: number; handler: () => void }
  | undefined;
function cancellationScope(): { signal: AbortSignal; dispose: () => void } {
  if (!cancellation) {
    const controller = new AbortController();
    const handler = () => controller.abort(new Error("Build queue cancelled"));
    cancellation = { controller, users: 0, handler };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  }
  const scope = cancellation;
  scope.users++;
  return {
    signal: scope.controller.signal,
    dispose: () => {
      if (--scope.users === 0) {
        process.removeListener("SIGINT", scope.handler);
        process.removeListener("SIGTERM", scope.handler);
        cancellation = undefined;
      }
    },
  };
}
export async function withQueueCancellation<T>(
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const scope = cancellationScope();
  try {
    const value = await action(scope.signal);
    scope.signal.throwIfAborted();
    return value;
  } catch (error) {
    if (scope.signal.aborted && !(error instanceof QueueOwnershipUncertain))
      throw new QueueCancellation(
        "Build queue cancelled; no successful result recorded.",
        { cause: error },
      );
    throw error;
  } finally {
    scope.dispose();
  }
}

export class QueueCancellation extends Error {}
export class QueueOwnershipUncertain extends Error {}

export async function runQueued(
  command: string,
  args: string[],
  cwd: string,
  label: string,
  sessionId = `process-${process.pid}`,
): Promise<CommandResult> {
  const scope = cancellationScope();
  try {
    const lease = await acquireBuildSlot(cwd, label, sessionId, scope.signal);
    let uncertain = false;
    const result = await withCleanup(
      async () => {
        try {
          return await execute(command, args, cwd, scope.signal);
        } catch (error) {
          uncertain = error instanceof QueueOwnershipUncertain;
          throw error;
        }
      },
      async () => {
        if (uncertain)
          process.stderr.write(
            `Build queue slot retained: ${lease.entry.id}. Inspect the workload, then use seshx queue recover only after all descendants stopped.\n`,
          );
        else await releaseBuildSlot(lease);
      },
      "Build queue cleanup",
    );
    scope.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (scope.signal.aborted && !(error instanceof QueueOwnershipUncertain))
      throw new QueueCancellation(
        "Build queue cancelled; no successful result recorded.",
        { cause: error },
      );
    throw error;
  } finally {
    scope.dispose();
  }
}
function execute(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<CommandResult> {
  signal.throwIfAborted();
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let termination: Promise<void> | undefined;
    const cancel = () => {
      if (!termination && child.pid) {
        termination = terminateTree(child.pid);
        // Attach a rejection handler immediately; close may arrive much later.
        void termination.catch(() => undefined);
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.once("error", (error) => {
      spawnError = spawnFailure(command, cwd, error);
    });
    child.once("close", async (code) => {
      signal.removeEventListener("abort", cancel);
      recordSubprocess(Number(process.hrtime.bigint() - started) / 1e6);
      try {
        if (termination) await termination;
        // A command must wait for its own children. Do not silently release
        // capacity if a POSIX command backgrounded work or cancellation failed.
        if (child.pid && process.platform !== "win32" && groupAlive(child.pid))
          throw new QueueOwnershipUncertain(
            `Command process group ${child.pid} still exists after exit; queue slot retained.`,
          );
        if (signal.aborted)
          throw new QueueCancellation("Build queue cancelled");
        if (spawnError) throw spawnError;
        resolve({ code: code ?? 1, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function terminateTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    // Invoke only for our currently owned child, never for a recovered/stale PID.
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.once("error", (error) =>
        reject(
          new QueueOwnershipUncertain(
            "Could not stop Windows process tree; preserve queue ownership.",
            { cause: error },
          ),
        ),
      );
      killer.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new QueueOwnershipUncertain(
                `taskkill failed (${code}); preserve queue ownership.`,
              ),
            ),
      );
    });
    return;
  }
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, sig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw new QueueOwnershipUncertain(
        "Could not stop process group; preserve queue ownership.",
        { cause: error },
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, sig === "SIGTERM" ? 1000 : 100),
    );
    if (!groupAlive(pid)) return;
  }
  // Zombies and inaccessible groups are deliberately not treated as proof of
  // completion. Recovery requires inspection, never killing a recorded PID.
  throw new QueueOwnershipUncertain(
    `Process group ${pid} remains after cancellation.`,
  );
}
