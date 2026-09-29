import { tryFileLock, releaseFileLock, withCleanup } from "./file-lock.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isNodeError, runtimePaths } from "./runtime.js";

type ResourceMode = "shared" | "exclusive";

interface ResourceLease {
  key: string;
  mode: ResourceMode;
  sessionId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface ResourceLockHandle {
  leases: string[];
}

export async function acquireValidationResources(
  shared: string[],
  exclusive: string[],
  sessionId: string,
  waitSeconds: number,
): Promise<ResourceLockHandle> {
  const requests = new Map<string, ResourceMode>();
  for (const key of shared) requests.set(key, "shared");
  for (const key of exclusive) requests.set(key, "exclusive");
  const leases: string[] = [];
  try {
    for (const [key, mode] of [...requests].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      leases.push(await acquireOne(key, mode, sessionId, waitSeconds));
    }
    return { leases };
  } catch (error) {
    return withCleanup(
      async () => {
        throw error;
      },
      () => releaseValidationResources({ leases }),
    );
  }
}

export async function releaseValidationResources(
  handle: ResourceLockHandle,
): Promise<void> {
  const releases = await Promise.allSettled(
    handle.leases.map((path) => rm(path, { force: true })),
  );
  const failures = releases
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason as unknown);
  if (failures.length)
    throw new AggregateError(
      failures,
      `Could not release validation resource leases: ${failures.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
    );
}

async function acquireOne(
  key: string,
  mode: ResourceMode,
  sessionId: string,
  waitSeconds: number,
): Promise<string> {
  const root = join(
    runtimePaths().locks,
    "validation-resources",
    createHash("sha256").update(key).digest("hex"),
  );
  const holders = join(root, "holders");
  const gate = join(root, "gate");
  await mkdir(holders, { recursive: true });
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  const leasePath = join(
    holders,
    `${process.pid}-${randomBytes(8).toString("hex")}.json`,
  );
  let announced = false;
  for (;;) {
    const gateLock = await tryFileLock(gate, { sessionId });
    if (gateLock) {
      const acquired = await withCleanup(
        async () => {
          await removeDeadLocalLeases(holders);
          const active = await readLeases(holders);
          const conflicts = active.filter(
            (lease) => mode === "exclusive" || lease.mode === "exclusive",
          );
          if (conflicts.length === 0) {
            const lease: ResourceLease = {
              key,
              mode,
              sessionId,
              pid: process.pid,
              hostname: hostname(),
              acquiredAt: new Date().toISOString(),
            };
            await writeFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, {
              flag: "wx",
            });
            return leasePath;
          }
          if (!announced) {
            process.stdout.write(
              `Validation resource ${JSON.stringify(key)} (${mode}) is busy; waiting...\n`,
            );
            announced = true;
          }
          return undefined;
        },
        () => releaseFileLock(gateLock),
      );
      if (acquired) return acquired;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for validation resource ${JSON.stringify(key)} (${mode})`,
      );
    }
    await delay(Math.min(100, Math.max(10, deadline - Date.now())));
  }
}

async function readLeases(directory: string): Promise<ResourceLease[]> {
  const names = await readdir(directory);
  const leases = await Promise.all(
    names.map(async (name) => {
      try {
        const lease: unknown = JSON.parse(
          await readFile(join(directory, name), "utf8"),
        );
        if (!validLease(lease)) throw new Error("invalid owner record");
        return lease;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return null;
        throw new Error(
          `Validation resource lease is unreadable or invalid: ${join(directory, name)}. Preserve it for inspection.`,
          { cause: error },
        );
      }
    }),
  );
  return leases.filter((lease): lease is ResourceLease => lease !== null);
}

async function removeDeadLocalLeases(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    try {
      const lease = JSON.parse(await readFile(path, "utf8")) as ResourceLease;
      if (
        validLease(lease) &&
        lease.hostname === hostname() &&
        !isAlive(lease.pid)
      ) {
        await rm(path, { force: true });
      }
    } catch {
      // Invalid ownership records are preserved conservatively.
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validLease(value: unknown): value is ResourceLease {
  if (!value || typeof value !== "object") return false;
  const lease = value as Partial<ResourceLease>;
  return (
    Number.isSafeInteger(lease.pid) &&
    (lease.pid ?? 0) > 0 &&
    typeof lease.hostname === "string" &&
    typeof lease.sessionId === "string" &&
    typeof lease.key === "string" &&
    typeof lease.acquiredAt === "string" &&
    (lease.mode === "shared" || lease.mode === "exclusive")
  );
}
