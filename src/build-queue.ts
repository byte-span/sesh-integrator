import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, homedir, hostname, totalmem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createServer, type Server } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { withCleanup } from "./file-lock.js";

export interface QueueSettings {
  concurrency: number | "auto" | "unlimited";
  waitSeconds: number;
}
export interface QueueEntry {
  version: 1;
  id: string;
  pid: number;
  hostname: string;
  sessionId: string;
  cwd: string;
  label: string;
  state: "waiting" | "running";
  queuedAt: string;
  startedAt?: string;
}
export interface QueueLease {
  root: string;
  entry: QueueEntry;
}
const defaults: QueueSettings = { concurrency: "unlimited", waitSeconds: 900 };

// Stable capacity, not a fluctuating free-memory snapshot. Leave room for the UI,
// OS and editors, and assume builds may each have their own worker pools.
export function defaultConcurrency(cpus: number, memoryBytes: number): number {
  const gib = 1024 ** 3;
  return Math.max(
    1,
    Math.min(
      4,
      Math.floor(cpus / 2),
      Math.floor((memoryBytes - 2 * gib) / (4 * gib)),
    ),
  );
}
export function queueRoot(): string {
  if (
    process.env.SESH_BUILD_QUEUE_HOME &&
    !isAbsolute(process.env.SESH_BUILD_QUEUE_HOME)
  )
    throw new Error(
      "SESH_BUILD_QUEUE_HOME must be an absolute local path shared by all participants.",
    );
  return resolve(
    process.env.SESH_BUILD_QUEUE_HOME ||
      join(
        homedir(),
        ".sesh-integrator",
        "build-queue",
        createHash("sha256").update(hostname()).digest("hex").slice(0, 16),
      ),
  );
}
export async function queueSettings(
  root = queueRoot(),
): Promise<QueueSettings> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  } catch (error) {
    if (code(error) === "ENOENT") return { ...defaults };
    throw error;
  }
  const settings = value as Partial<QueueSettings> | null;
  if (
    !settings ||
    typeof settings !== "object" ||
    Object.keys(settings).some(
      (key) => !["concurrency", "waitSeconds"].includes(key),
    ) ||
    !(
      settings.concurrency === "auto" ||
      settings.concurrency === "unlimited" ||
      (Number.isSafeInteger(settings.concurrency) &&
        Number(settings.concurrency) >= 1 &&
        Number(settings.concurrency) <= 64)
    ) ||
    !Number.isSafeInteger(settings.waitSeconds) ||
    Number(settings.waitSeconds) < 1 ||
    Number(settings.waitSeconds) > 86400
  )
    throw new Error(
      `Invalid build queue config: ${join(root, "config.json")}. Use concurrency "unlimited", "auto" or 1–64 and waitSeconds 1–86400.`,
    );
  return settings as QueueSettings;
}
function capacity(settings: QueueSettings): number {
  if (settings.concurrency === "unlimited") return Infinity;
  const constrained = process.constrainedMemory?.() || Infinity;
  return settings.concurrency === "auto"
    ? defaultConcurrency(
        availableParallelism(),
        Math.min(totalmem(), constrained),
      )
    : settings.concurrency;
}
export function ownerAlive(
  entry: Pick<QueueEntry, "pid" | "hostname">,
): boolean {
  if (entry.hostname !== hostname()) return true;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (error) {
    return code(error) !== "ESRCH";
  }
}
export async function queueEntries(root = queueRoot()): Promise<QueueEntry[]> {
  let names: string[];
  try {
    names = await readdir(join(root, "entries"));
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
  const entries: QueueEntry[] = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(root, "entries", name), "utf8"));
    } catch (error) {
      if (code(error) === "ENOENT") continue;
      throw new Error(
        `Unreadable build queue entry ${name}; preserve it for inspection.`,
        { cause: error },
      );
    }
    const e = value as Partial<QueueEntry> | null;
    if (
      !e ||
      e.version !== 1 ||
      typeof e.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(e.id) ||
      name !== `${e.id}.json` ||
      !Number.isSafeInteger(e.pid) ||
      Number(e.pid) < 1 ||
      typeof e.hostname !== "string" ||
      typeof e.cwd !== "string" ||
      typeof e.sessionId !== "string" ||
      typeof e.label !== "string" ||
      typeof e.queuedAt !== "string" ||
      !Number.isFinite(Date.parse(e.queuedAt)) ||
      !["waiting", "running"].includes(e.state ?? "")
    )
      throw new Error(
        `Invalid build queue entry ${name}; preserve it for inspection.`,
      );
    entries.push(e as QueueEntry);
  }
  return entries.sort(
    (a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id),
  );
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}
function entryPath(root: string, id: string): string {
  return join(root, "entries", `${id}.json`);
}

// A short-lived OS-owned loopback listener is the admission mutex. It accepts
// no protocol/data and closes after one filesystem transaction. Unlike a file
// gate, the OS releases it even on SIGKILL; no stale-gate deletion race exists.
// A port collision only delays/fails admission; it cannot over-admit work.
export async function gate<T>(
  root: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
  waitMs = 10000,
  onWait?: () => void,
  reuse = false,
): Promise<T> {
  await mkdir(join(root, "entries"), { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  const port =
    (reuse ? 50000 : 20000) +
    (createHash("sha256").update(canonical).digest().readUInt32BE(0) %
      (reuse ? 15000 : 30000));
  const deadline = Date.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted();
    const server = await listen(port);
    if (server)
      return withCleanup(
        action,
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
        "Build queue gate cleanup",
      );
    if (Date.now() >= deadline)
      throw new Error(
        `Build queue admission mutex busy on 127.0.0.1:${port}; retry after the current operation ends. Queue: ${root}`,
      );
    onWait?.();
    await delay(reuse ? 25 : 1, undefined, { signal });
  }
}
function listen(port: number): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (error) =>
      code(error) === "EADDRINUSE" ? resolve(undefined) : reject(error),
    );
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      resolve(server),
    );
  });
}
export async function acquireBuildSlot(
  cwd: string,
  label: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<QueueLease> {
  const root = queueRoot();
  const settings = await queueSettings(root);
  const entry: QueueEntry = {
    version: 1,
    id: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    sessionId,
    cwd,
    label,
    state: "waiting",
    queuedAt: new Date().toISOString(),
  };
  const lease = { root, entry };
  let registered = false;
  const deadline = Date.now() + settings.waitSeconds * 1000;
  let announced = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await gate(
        root,
        async () => {
          if (!registered) {
            await atomicJson(entryPath(root, entry.id), entry);
            registered = true;
          }
          const entries = await queueEntries(root);
          // Dead waiting owners cannot have launched work: running is persisted
          // under this gate before spawn. Dead running owners may have descendants.
          for (const e of entries)
            if (e.state === "waiting" && !ownerAlive(e))
              await unlink(entryPath(root, e.id));
          const active = entries.filter(
            (e) => e.state === "running" || ownerAlive(e),
          );
          const running = active.filter((e) => e.state === "running").length;
          const waiting = active.filter((e) => e.state === "waiting");
          const limit = capacity(await queueSettings(root));
          const position = waiting.findIndex((e) => e.id === entry.id);
          if (position < 0)
            throw new Error(`Build queue ownership lost: ${entry.id}`);
          const orphaned = active.some(
            (e) => e.state === "running" && !ownerAlive(e),
          );
          // Reserve capacity for earlier waiters without forcing each free slot
          // to wait for the head waiter's next polling interval.
          if (position < limit - running && !orphaned) {
            entry.state = "running";
            entry.startedAt = new Date().toISOString();
            await atomicJson(entryPath(root, entry.id), entry);
            return {
              admitted: true,
              message: `Build queue running (${running + 1}/${limit === Infinity ? "unlimited" : limit}): ${label} [${sessionId}]`,
            };
          }
          return {
            admitted: false,
            message: `Build queue waiting (#${position + 1}, ${running}/${limit === Infinity ? "unlimited" : limit} running${orphaned ? "; orphaned owner needs recovery" : ""}): ${label} [${sessionId}]`,
          };
        },
        signal,
      );
      if (result.message !== announced) {
        process.stdout.write(result.message + "\n");
        announced = result.message;
      }
      if (result.admitted) return lease;
      if (Date.now() >= deadline)
        throw new Error(
          `Timed out waiting for build queue after ${settings.waitSeconds}s. Run seshx queue status; queue: ${root}`,
        );
      await delay(100, undefined, { signal });
    }
  } catch (error) {
    if (!registered) throw error;
    return withCleanup(
      async () => {
        throw error;
      },
      () => releaseBuildSlot(lease),
    );
  }
}
export async function releaseBuildSlot(lease: QueueLease): Promise<void> {
  await gate(lease.root, async () => {
    const current = (await queueEntries(lease.root)).find(
      (e) => e.id === lease.entry.id,
    );
    if (
      !current ||
      current.pid !== process.pid ||
      current.hostname !== hostname()
    )
      throw new Error(
        `Build queue ownership changed; preserving ${lease.entry.id}`,
      );
    await unlink(entryPath(lease.root, lease.entry.id));
  });
}
export async function printBuildQueue(): Promise<void> {
  const root = queueRoot();
  const settings = await queueSettings(root);
  const entries = await queueEntries(root);
  process.stdout.write(
    `Build queue: ${root}\n  concurrency: ${settings.concurrency === "unlimited" ? "unlimited" : capacity(settings)} (${settings.concurrency === "auto" ? "resource-aware limit" : settings.concurrency === "unlimited" ? "no throttling" : "machine override"}); wait: ${settings.waitSeconds}s\n`,
  );
  for (const entry of entries)
    process.stdout.write(
      `  ${entry.id} ${entry.state}${!ownerAlive(entry) ? " (orphaned; inspect before recovery)" : ""}: ${stripVTControlCharacters(entry.label)}; session ${stripVTControlCharacters(entry.sessionId)}; pid ${entry.pid}; ${stripVTControlCharacters(entry.cwd)}\n`,
    );
  if (!entries.length) process.stdout.write("  idle\n");
}
export async function queueCommand(args: string[]): Promise<void> {
  if (!args.length || (args.length === 1 && args[0] === "status"))
    return printBuildQueue();
  const root = queueRoot();
  if (
    args[0] === "configure" &&
    args.length === 3 &&
    ["--concurrency", "--wait-seconds"].includes(args[1]!)
  ) {
    const value =
      ["auto", "unlimited"].includes(args[2]!) && args[1] === "--concurrency"
        ? (args[2] as "auto" | "unlimited")
        : Number(args[2]);
    if (
      typeof value === "number" &&
      (!Number.isSafeInteger(value) ||
        value < 1 ||
        value > (args[1] === "--concurrency" ? 64 : 86400))
    )
      throw new Error("Invalid build queue setting.");
    await gate(root, async () => {
      const settings = await queueSettings(root);
      if (args[1] === "--concurrency") settings.concurrency = value;
      else settings.waitSeconds = value as number;
      await atomicJson(join(root, "config.json"), settings);
    });
    return printBuildQueue();
  }
  if (
    args[0] === "recover" &&
    args.length === 3 &&
    args[2] === "--confirmed-stopped"
  ) {
    await gate(root, async () => {
      const entry = (await queueEntries(root)).find((e) => e.id === args[1]);
      if (!entry) throw new Error("Unknown build queue entry.");
      if (ownerAlive(entry))
        throw new Error(
          "Queue owner is live, remote, or ambiguous; refusing recovery.",
        );
      await unlink(entryPath(root, entry.id));
    });
    process.stdout.write(
      "Queue slot released after confirmation that its entire workload stopped. Validation results are unchanged; retry the interrupted lifecycle command.\n",
    );
    return;
  }
  throw new Error(
    "Usage: seshx queue [status | configure --concurrency <unlimited|auto|1-64> | configure --wait-seconds <1-86400> | recover <entry-id> --confirmed-stopped]",
  );
}
function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
