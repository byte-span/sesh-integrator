import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  acquireBuildSlot,
  defaultConcurrency,
  queueCommand,
  queueEntries,
  queueRoot,
  queueSettings,
  releaseBuildSlot,
  type QueueEntry,
} from "../src/build-queue.js";
import { commandFingerprint, runValidation } from "../src/process.js";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
});
const processModule = pathToFileURL(
  join(process.cwd(), "dist/process.js"),
).href;
const queuedModule = pathToFileURL(
  join(process.cwd(), "dist/queued-process.js"),
).href;
const queueModule = pathToFileURL(
  join(process.cwd(), "dist/build-queue.js"),
).href;
function launch(source: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    output += String(chunk);
  });
  const done = new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    },
  );
  return { child, done, output: () => output };
}
async function until(predicate: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for fixture state");
}
function command(id: string, events: string, ms = 250): [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `const fs=require('fs');const p=${JSON.stringify(events)};fs.appendFileSync(p,JSON.stringify({id:${JSON.stringify(id)},kind:'start',time:Date.now()})+'\\n');setTimeout(()=>fs.appendFileSync(p,JSON.stringify({id:${JSON.stringify(id)},kind:'end',time:Date.now()})+'\\n'),${ms});`,
  ];
}
async function config(concurrency: number, waitSeconds = 10) {
  await writeFile(
    join(queueRoot(), "config.json"),
    JSON.stringify({ concurrency, waitSeconds }),
  );
}
async function stale(state: "waiting" | "running") {
  const probe = launch("process.exit(0)");
  await probe.done;
  const entry: QueueEntry = {
    version: 1,
    id: randomUUID(),
    pid: probe.child.pid!,
    hostname: hostname(),
    sessionId: "crashed",
    cwd: queueRoot(),
    label: "fixture",
    state,
    queuedAt: "2000-01-01T00:00:00Z",
  };
  await mkdir(join(queueRoot(), "entries"), { recursive: true });
  await writeFile(
    join(queueRoot(), "entries", `${entry.id}.json`),
    JSON.stringify(entry),
  );
  return entry;
}

it("chooses bounded resource-aware defaults for small and large machines", () => {
  const gib = 1024 ** 3;
  expect(defaultConcurrency(1, gib)).toBe(1);
  expect(defaultConcurrency(32, 8 * gib)).toBe(1);
  expect(defaultConcurrency(8, 16 * gib)).toBe(3);
  expect(defaultConcurrency(128, 512 * gib)).toBe(4);
});
it("validates machine overrides and preserves independent settings", async () => {
  await queueCommand(["configure", "--concurrency", "3"]);
  await queueCommand(["configure", "--wait-seconds", "20"]);
  expect(await queueSettings()).toEqual({ concurrency: 3, waitSeconds: 20 });
  await expect(
    queueCommand(["configure", "--concurrency", "0"]),
  ).rejects.toThrow("Invalid");
  await writeFile(join(queueRoot(), "config.json"), '{"concurrency":0}');
  await expect(queueSettings()).rejects.toThrow("Invalid");
});
it.each([1, 2])(
  "limits concurrent sessions across repositories and runtime homes to %i",
  async (limit) => {
    await config(limit);
    const events = join(queueRoot(), "events");
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const repo = join(queueRoot(), `repo-${i % 2}`);
      await mkdir(repo, { recursive: true });
      execFileSync("git", ["init", "--quiet", repo]);
      const cmd = command(String(i), events, 400);
      runs.push(
        launch(
          `import {runValidation} from ${JSON.stringify(processModule)};await runValidation([${JSON.stringify(cmd)}],${JSON.stringify(repo)},{sessionId:'session-${i}'});`,
          { SESH_INTEGRATOR_HOME: join(queueRoot(), `runtime-${i}`) },
        ),
      );
    }
    await until(async () =>
      (await queueEntries()).some((e) => e.state === "waiting"),
    );
    await queueCommand(["status"]);
    const results = await Promise.all(runs.map((run) => run.done));
    for (const result of results) expect(result.code, result.output).toBe(0);
    let active = 0,
      peak = 0;
    for (const line of (await readFile(events, "utf8")).trim().split("\n")) {
      active += JSON.parse(line).kind === "start" ? 1 : -1;
      peak = Math.max(peak, active);
    }
    expect(peak).toBe(limit);
    expect(active).toBe(0);
    expect(await queueEntries()).toEqual([]);
  },
);
it("does not queue cache hits or cache failures, and waits for parallel siblings", async () => {
  await config(1);
  const root = queueRoot();
  const cached: [string, ...string[]] = [
    process.execPath,
    "-e",
    "throw Error('must not run')",
  ];
  const successes: string[] = [];
  expect(
    await runValidation([cached], root, {
      cachedFingerprints: new Set([commandFingerprint(cached)]),
    }),
  ).toEqual({ cacheHits: 1, executed: 0 });
  const events = join(root, "events");
  await expect(
    runValidation(
      [
        {
          parallel: [
            [process.execPath, "-e", "process.exit(7)"],
            command("sibling", events, 300),
          ],
        },
      ],
      root,
      {
        onCommandSuccess: async () => {
          successes.push("cached");
        },
      },
    ),
  ).rejects.toThrow("Validation failed (7)");
  expect(successes).toEqual([]);
  expect(await queueEntries()).toEqual([]);
  expect(await readFile(events, "utf8")).toContain('"kind":"end"');
});
it("reclaims a dead waiter but preserves dead running ownership until confirmed recovery", async () => {
  await config(1, 1);
  await stale("waiting");
  const lease = await acquireBuildSlot(
    queueRoot(),
    "check",
    "test",
    new AbortController().signal,
  );
  await releaseBuildSlot(lease);
  const dead = await stale("running");
  await expect(
    acquireBuildSlot(
      queueRoot(),
      "blocked",
      "test",
      new AbortController().signal,
    ),
  ).rejects.toThrow("Timed out");
  expect((await queueEntries()).map((e) => e.id)).toEqual([dead.id]);
  await expect(queueCommand(["recover", dead.id])).rejects.toThrow("Usage");
  await queueCommand(["recover", dead.id, "--confirmed-stopped"]);
  const recovered = await acquireBuildSlot(
    queueRoot(),
    "recovered",
    "test",
    new AbortController().signal,
  );
  await releaseBuildSlot(recovered);
});
it("refuses recovery of live, foreign and malformed ownership", async () => {
  const lease = await acquireBuildSlot(
    queueRoot(),
    "live",
    "test",
    new AbortController().signal,
  );
  await expect(
    queueCommand(["recover", lease.entry.id, "--confirmed-stopped"]),
  ).rejects.toThrow("refusing");
  await releaseBuildSlot(lease);
  const dead = await stale("running");
  const file = join(queueRoot(), "entries", `${dead.id}.json`);
  await writeFile(
    file,
    JSON.stringify({ ...dead, hostname: "another-machine" }),
  );
  await expect(
    queueCommand(["recover", dead.id, "--confirmed-stopped"]),
  ).rejects.toThrow("refusing");
  await writeFile(file, "broken");
  await expect(queueEntries()).rejects.toThrow("Unreadable");
  expect(await readFile(file, "utf8")).toBe("broken");
});
it("cancels a waiter without starting its command", async () => {
  await config(1);
  const lease = await acquireBuildSlot(
    queueRoot(),
    "holder",
    "test",
    new AbortController().signal,
  );
  const events = join(queueRoot(), "events");
  const run = launch(
    `import {runQueued} from ${JSON.stringify(queuedModule)};const c=${JSON.stringify(command("cancelled", events))};await runQueued(c[0],c.slice(1),${JSON.stringify(queueRoot())},'waiting');`,
  );
  await until(() => run.output().includes("Build queue waiting"));
  run.child.kill("SIGTERM");
  expect((await run.done).code).not.toBe(0);
  expect((await queueEntries()).length).toBe(1);
  await expect(readFile(events)).rejects.toThrow();
  await releaseBuildSlot(lease);
});
it("cancels a running workload without recording success and frees its slot", async () => {
  const run = launch(
    `import {runQueued} from ${JSON.stringify(queuedModule)};await runQueued(process.execPath,['-e','console.log("WORK_READY");setTimeout(()=>{},20000)'],${JSON.stringify(queueRoot())},'running');`,
  );
  await until(() => run.output().includes("WORK_READY"));
  run.child.kill("SIGTERM");
  const result = await run.done;
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("cancelled");
  expect(await queueEntries()).toEqual([]);
});
it("retains a slot after abrupt owner death and allows inspected recovery", async () => {
  const run = launch(
    `import {acquireBuildSlot} from ${JSON.stringify(queueModule)};await acquireBuildSlot(${JSON.stringify(queueRoot())},'crash','test',new AbortController().signal);console.log('OWNED');setTimeout(()=>{},20000);`,
  );
  await until(() => run.output().includes("OWNED"));
  run.child.kill("SIGKILL");
  await run.done;
  const entries = await queueEntries();
  expect(entries).toHaveLength(1);
  await queueCommand(["recover", entries[0]!.id, "--confirmed-stopped"]);
  expect(await queueEntries()).toEqual([]);
});

it("retains ownership while an orphaned real workload finishes after owner death", async () => {
  await config(1, 1);
  const events = join(queueRoot(), "orphan-events");
  const cmd = command("orphan", events, 1800);
  const run = launch(
    `import {runQueued} from ${JSON.stringify(queuedModule)};const c=${JSON.stringify(cmd)};await runQueued(c[0],c.slice(1),${JSON.stringify(queueRoot())},'orphan');`,
  );
  await until(async () => {
    try {
      return (await readFile(events, "utf8")).includes('"kind":"start"');
    } catch {
      return false;
    }
  });
  run.child.kill("SIGKILL");
  await expect(
    acquireBuildSlot(
      queueRoot(),
      "blocked",
      "test",
      new AbortController().signal,
    ),
  ).rejects.toThrow("Timed out");
  await run.done;
  await until(async () =>
    (await readFile(events, "utf8")).includes('"kind":"end"'),
  );
  const [entry] = await queueEntries();
  expect(entry?.state).toBe("running");
  await queueCommand(["recover", entry!.id, "--confirmed-stopped"]);
});
it("applies decreased capacity without interrupting admitted work", async () => {
  await config(2);
  const a = await acquireBuildSlot(
    queueRoot(),
    "a",
    "test",
    new AbortController().signal,
  );
  const b = await acquireBuildSlot(
    queueRoot(),
    "b",
    "test",
    new AbortController().signal,
  );
  await queueCommand(["configure", "--concurrency", "1"]);
  const abort = new AbortController();
  const pending = acquireBuildSlot(queueRoot(), "c", "test", abort.signal);
  void pending.catch(() => undefined);
  await until(async () => (await queueEntries()).length === 3);
  await releaseBuildSlot(a);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect((await queueEntries()).find((e) => e.label === "c")?.state).toBe(
    "waiting",
  );
  await releaseBuildSlot(b);
  const c = await pending;
  await releaseBuildSlot(c);
});
it("records success only after actual queued execution", async () => {
  const commands: string[][] = [];
  const cmd: [string, ...string[]] = [process.execPath, "--version"];
  expect(
    await runValidation([cmd], queueRoot(), {
      onCommandSuccess: async (command) => {
        commands.push(command);
      },
    }),
  ).toEqual({ cacheHits: 0, executed: 1 });
  expect(commands).toEqual([cmd]);
});

it("cancels parallel resource waiters without launching them or retrying", async () => {
  const events = join(queueRoot(), "resource-events");
  const a = {
    command: command("a", events, 20000),
    resources: { exclusive: ["fixture"] },
    failure: { classification: "transient", maxAttempts: 3 },
  };
  const b = { ...a, command: command("b", events, 20000) };
  const run = launch(
    `import {runValidation} from ${JSON.stringify(processModule)};await runValidation([{parallel:${JSON.stringify([a, b])}}],${JSON.stringify(queueRoot())});`,
    { SESH_INTEGRATOR_HOME: join(queueRoot(), "runtime") },
  );
  await until(async () => {
    try {
      return (await readFile(events, "utf8")).includes('"kind":"start"');
    } catch {
      return false;
    }
  });
  run.child.kill("SIGTERM");
  const result = await run.done;
  expect(result.code).not.toBe(0);
  expect((await readFile(events, "utf8")).trim().split("\n")).toHaveLength(1);
  expect(await queueEntries()).toEqual([]);
});
it("recovers the OS admission mutex automatically after its owner crashes", async () => {
  const run = launch(
    `import {createServer} from 'node:net';import {createHash} from 'node:crypto';import {realpath} from 'node:fs/promises';const canonical=await realpath(${JSON.stringify(queueRoot())});const port=20000+createHash('sha256').update(canonical).digest().readUInt32BE(0)%30000;createServer(s=>s.destroy()).listen({host:'127.0.0.1',port,exclusive:true},()=>console.log('GATE_READY'));`,
  );
  await until(() => run.output().includes("GATE_READY"));
  const pending = acquireBuildSlot(
    queueRoot(),
    "after gate crash",
    "test",
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(await queueEntries()).toEqual([]);
  run.child.kill("SIGKILL");
  await run.done;
  const lease = await pending;
  await releaseBuildSlot(lease);
});
