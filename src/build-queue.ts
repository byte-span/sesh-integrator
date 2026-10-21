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
import { connect, createServer, type Server } from "node:net";
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
/**
 * A lightweight command running without a slot (bypassBuildQueue). Kept in
 * `bypassed/`, never `entries/`: it holds no capacity, admission ignores it,
 * and older coordinators, which reject unknown entry states, never read it.
 */
export interface QueueBypass {
  version: 1;
  id: string;
  pid: number;
  hostname: string;
  sessionId: string;
  cwd: string;
  label: string;
  reason: string;
  startedAt: string;
}
export interface QueueBypassLease {
  root: string;
  bypass: QueueBypass;
}
// Machines without config.json get a resource-aware limit. 7f64fc1 defaulted to
// "unlimited" because "auto" gave one slot on a 7.5 GiB benchmark machine,
// serializing concurrent validations (about 3x slower than pre-queue). That
// trades memory protection for speed, so "unlimited" is now opt-in; waits time
// out only without progress, so a slower but moving queue does not fail.
const defaults: QueueSettings = { concurrency: "auto", waitSeconds: 900 };

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
  return (await loadQueueSettings(root)).settings;
}
async function loadQueueSettings(
  root: string,
): Promise<{ settings: QueueSettings; explicit: boolean }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  } catch (error) {
    if (code(error) === "ENOENT")
      return { settings: { ...defaults }, explicit: false };
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
  return { settings: settings as QueueSettings, explicit: true };
}
// Memory uses the lower of OS total memory and Node's process constraint.
function autoInputs(): { cpus: number; memoryBytes: number } {
  const constrained = process.constrainedMemory?.() || Infinity;
  return {
    cpus: availableParallelism(),
    memoryBytes: Math.min(totalmem(), constrained),
  };
}
export function queueCapacity(settings: QueueSettings): number {
  if (settings.concurrency === "unlimited") return Infinity;
  if (settings.concurrency !== "auto") return settings.concurrency;
  const { cpus, memoryBytes } = autoInputs();
  return defaultConcurrency(cpus, memoryBytes);
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

// Ports depend only on the canonical root so every participant agrees. Current
// ports stay below the Linux (32768–60999) and IANA (49152–65535) ephemeral
// ranges, where any loopback connection, including a 60-second TIME_WAIT, can
// occupy the port longer than admission waits. Legacy ports are those used by
// coordinators pinned before this change. All four ranges are disjoint so a
// process holding a reuse mutex can still take the nested admission mutex.
export function admissionPorts(
  canonical: string,
  reuse = false,
): { port: number; legacyPort: number } {
  const hash = createHash("sha256").update(canonical).digest().readUInt32BE(0);
  return {
    port: (reuse ? 15000 : 10000) + (hash % 5000),
    legacyPort: (reuse ? 50000 : 20000) + (hash % (reuse ? 15000 : 30000)),
  };
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
  const { port, legacyPort } = admissionPorts(await realpath(root), reuse);
  const deadline = Date.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted();
    const server = await listen(port);
    let legacy: Server | "busy" | "occupied" = "busy";
    if (server)
      try {
        legacy = await holdLegacy(legacyPort);
      } catch (error) {
        await close(server);
        throw error;
      }
    if (server && legacy !== "busy")
      return withCleanup(
        action,
        async () => {
          if (legacy !== "occupied") await close(legacy);
          await close(server);
        },
        "Build queue gate cleanup",
      );
    if (server) await close(server);
    if (Date.now() >= deadline)
      throw new Error(
        `Build queue admission mutex busy on 127.0.0.1:${server ? legacyPort : port}; retry after the current operation ends. Queue: ${root}`,
      );
    onWait?.();
    await delay(reuse ? 25 : 1, undefined, { signal });
  }
}
// Older pinned coordinators exclude each other only through the legacy port,
// so hold it too. Any listener there may be their mutex and is waited for. A
// port occupied by a non-listening socket (an outbound connection or
// TIME_WAIT) rejects their listeners as well, so it is skipped; the second
// attempt keeps a gate released between listen and probe from being skipped.
async function holdLegacy(port: number): Promise<Server | "busy" | "occupied"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = await listen(port);
    if (server) return server;
    if (await listening(port)) return "busy";
  }
  return "occupied";
}
// Unclear outcomes count as a listener so admission fails closed.
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    // Windows reports a refused loopback connection only after SYN retries.
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", (error) => {
      socket.destroy();
      resolve(code(error) !== "ECONNREFUSED");
    });
    // Reset rather than close so the probe leaves no TIME_WAIT behind.
    socket.once("connect", () => {
      socket.resetAndDestroy();
      resolve(true);
    });
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
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
  // waitSeconds bounds time without progress, not total wait: a running entry
  // finishing or this request moving up restarts the deadline.
  const waitMs = settings.waitSeconds * 1000;
  let deadline = Date.now() + waitMs;
  let seenRunning = new Set<string>();
  let lastPosition = Infinity;
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
          const runningEntries = active.filter((e) => e.state === "running");
          const running = runningEntries.length;
          const waiting = active.filter((e) => e.state === "waiting");
          const limit = queueCapacity(await queueSettings(root));
          const position = waiting.findIndex((e) => e.id === entry.id);
          if (position < 0)
            throw new Error(`Build queue ownership lost: ${entry.id}`);
          // An orphan blocks every admission until a person confirms its
          // workload stopped, so waiting out the deadline cannot help.
          const orphans = runningEntries.filter((e) => !ownerAlive(e));
          if (orphans.length) throw new Error(orphanedMessage(orphans, root));
          const progressed =
            position < lastPosition ||
            [...seenRunning].some(
              (id) => !runningEntries.some((e) => e.id === id),
            );
          seenRunning = new Set(runningEntries.map((e) => e.id));
          lastPosition = position;
          const capacityLabel = limit === Infinity ? "unlimited" : limit;
          // Reserve capacity for earlier waiters without forcing each free slot
          // to wait for the head waiter's next polling interval.
          if (position < limit - running) {
            entry.state = "running";
            entry.startedAt = new Date().toISOString();
            await atomicJson(entryPath(root, entry.id), entry);
            return {
              admitted: true,
              progressed,
              place: "",
              message: `Build queue running (${running + 1}/${capacityLabel}): ${label} [${sessionId}]`,
            };
          }
          const place = `#${position + 1}, ${running}/${capacityLabel} running`;
          return {
            admitted: false,
            progressed,
            place,
            message: `Build queue waiting (${place}): ${label} [${sessionId}]`,
          };
        },
        signal,
      );
      if (result.message !== announced) {
        process.stdout.write(result.message + "\n");
        announced = result.message;
      }
      if (result.admitted) return lease;
      if (result.progressed) deadline = Date.now() + waitMs;
      else if (Date.now() >= deadline)
        throw new Error(
          `Timed out after ${settings.waitSeconds}s without build queue progress (${result.place}): no running command finished and this request did not move up. Run seshx queue status to inspect the running commands; raise the limit with seshx queue configure --wait-seconds <1-86400>. Queue: ${root}`,
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
function bypassPath(root: string, id: string): string {
  return join(root, "bypassed", `${id}.json`);
}
/**
 * Record a command that runs without a slot so queue status can show it. No
 * admission mutex: the record changes no capacity. Records of dead local
 * owners are pruned here because they never held a slot to recover.
 */
export async function registerQueueBypass(
  cwd: string,
  label: string,
  sessionId: string,
  reason: string,
): Promise<QueueBypassLease> {
  const root = queueRoot();
  await mkdir(join(root, "bypassed"), { recursive: true, mode: 0o700 });
  for (const stale of await queueBypasses(root))
    if (!ownerAlive(stale))
      await unlink(bypassPath(root, stale.id)).catch(() => undefined);
  const bypass: QueueBypass = {
    version: 1,
    id: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    sessionId,
    cwd,
    label,
    reason,
    startedAt: new Date().toISOString(),
  };
  await atomicJson(bypassPath(root, bypass.id), bypass);
  return { root, bypass };
}
export async function releaseQueueBypass(
  lease: QueueBypassLease,
): Promise<void> {
  try {
    await unlink(bypassPath(lease.root, lease.bypass.id));
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
}
/** Commands currently running without a slot. Unreadable records are skipped. */
export async function queueBypasses(
  root = queueRoot(),
): Promise<QueueBypass[]> {
  let names: string[];
  try {
    names = await readdir(join(root, "bypassed"));
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
  const records: QueueBypass[] = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    let value: Partial<QueueBypass> | null;
    try {
      value = JSON.parse(
        await readFile(join(root, "bypassed", name), "utf8"),
      ) as Partial<QueueBypass> | null;
    } catch {
      continue; // Removed or mid-write; it holds no capacity either way.
    }
    if (
      value &&
      value.version === 1 &&
      typeof value.id === "string" &&
      name === `${value.id}.json` &&
      Number.isSafeInteger(value.pid) &&
      typeof value.hostname === "string" &&
      typeof value.sessionId === "string" &&
      typeof value.cwd === "string" &&
      typeof value.label === "string" &&
      typeof value.reason === "string" &&
      typeof value.startedAt === "string"
    )
      records.push(value as QueueBypass);
  }
  return records.sort(
    (a, b) =>
      a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
  );
}
function orphanedMessage(orphans: QueueEntry[], root: string): string {
  const plain = stripVTControlCharacters;
  return [
    `Build queue blocked: ${orphans.length === 1 ? "the owner of this running entry exited. Its" : "the owners of these running entries exited. Their"} build/test commands may still be running, so no new command can start until recovery.`,
    ...orphans.map(
      (e) =>
        `  ${e.id}: ${plain(e.label)}; session ${plain(e.sessionId)}; pid ${e.pid}; ${plain(e.cwd)}`,
    ),
    "To recover:",
    "  1. Confirm in the OS process tools (for example ps or Task Manager) that the original CLI and all its descendants stopped. Never kill an unrelated or reused PID.",
    ...orphans.map(
      (e, i) =>
        `  ${i === 0 ? "2. Run:" : "   Run:"} seshx queue recover ${e.id} --confirmed-stopped`,
    ),
    "  3. Retry this command with its pinned coordinator.",
    `Queue: ${root}`,
  ].join("\n");
}
export async function printBuildQueue(): Promise<void> {
  const root = queueRoot();
  const { settings, explicit } = await loadQueueSettings(root);
  const entries = await queueEntries(root);
  const source = explicit ? "machine setting" : "default";
  let concurrency: string;
  if (settings.concurrency === "unlimited")
    concurrency = `unlimited (no throttling; ${source})`;
  else if (settings.concurrency === "auto") {
    const { cpus, memoryBytes } = autoInputs();
    concurrency = `${queueCapacity(settings)} (auto, ${source}: resource-aware limit for ${cpus} CPU threads and ${(memoryBytes / 1024 ** 3).toFixed(1)} GiB memory)`;
  } else concurrency = `${settings.concurrency} (${source})`;
  process.stdout.write(
    `Build queue: ${root}\n  concurrency: ${concurrency}\n  wait: ${settings.waitSeconds}s without progress (${source})\n  settings: ${explicit ? join(root, "config.json") : "built-in defaults (no config.json)"}\n`,
  );
  for (const entry of entries)
    process.stdout.write(
      `  ${entry.id} ${entry.state}${ownerAlive(entry) ? "" : entry.state === "running" ? ` (orphaned; after confirming its workload stopped: seshx queue recover ${entry.id} --confirmed-stopped)` : " (orphaned; inspect before recovery)"}: ${stripVTControlCharacters(entry.label)}; session ${stripVTControlCharacters(entry.sessionId)}; pid ${entry.pid}; ${stripVTControlCharacters(entry.cwd)}\n`,
    );
  // Bypassing commands hold no slot and need no recovery; a dead owner's
  // record is only pruned, by the next bypassing command.
  const bypasses = await queueBypasses(root);
  for (const bypass of bypasses)
    process.stdout.write(
      `  ${bypass.id} bypassed queue (${stripVTControlCharacters(bypass.reason)}; no slot used${ownerAlive(bypass) ? "" : "; owner exited"}): ${stripVTControlCharacters(bypass.label)}; session ${stripVTControlCharacters(bypass.sessionId)}; pid ${bypass.pid}; ${stripVTControlCharacters(bypass.cwd)}\n`,
    );
  if (!entries.length)
    process.stdout.write(
      bypasses.length ? "  no queue slots in use\n" : "  idle\n",
    );
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
