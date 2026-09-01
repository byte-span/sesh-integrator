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
    await releaseValidationResources({ leases });
    throw error;
  }
}

export async function releaseValidationResources(
  handle: ResourceLockHandle,
): Promise<void> {
  await Promise.all(handle.leases.map((path) => rm(path, { force: true })));
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
    if (await tryGate(gate)) {
      try {
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
      } finally {
        await rm(gate, { recursive: true, force: true });
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for validation resource ${JSON.stringify(key)} (${mode})`,
      );
    }
    await delay(Math.min(100, Math.max(10, deadline - Date.now())));
  }
}

async function tryGate(path: string): Promise<boolean> {
  try {
    await mkdir(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return false;
    throw error;
  }
}

async function readLeases(directory: string): Promise<ResourceLease[]> {
  const names = await readdir(directory);
  const leases = await Promise.all(
    names.map(async (name) => {
      try {
        return JSON.parse(
          await readFile(join(directory, name), "utf8"),
        ) as ResourceLease;
      } catch {
        return null;
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
      if (lease.hostname === hostname() && !isAlive(lease.pid)) {
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
