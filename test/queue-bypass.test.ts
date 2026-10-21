import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireBuildSlot,
  queueBypasses,
  queueCommand,
  queueEntries,
  queueRoot,
  releaseBuildSlot,
  type QueueLease,
} from "../src/build-queue.js";
import { batchValidation } from "../src/integration-batch.js";
import { runValidation, ValidationFailure } from "../src/process.js";
import { validateConfig } from "../src/runtime.js";
import type { Config, RepositoryConfig, Session } from "../src/types.js";
import { validationQueueBypass } from "../src/validation.js";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  repo: string;
  runtime: string;
  home: string;
  log: string;
  gate: string;
  release: string;
}

const cli =
  process.env.PARALLEL_INTEGRATOR_TEST_CLI ??
  join(process.cwd(), "dist", "cli.js");
// Optionally prove that a real coordinator built before bypassBuildQueue (for
// example an installed release's dist/cli.js) keeps queueing with the new keys.
const legacyCli = process.env.SESH_INTEGRATOR_TEST_LEGACY_CLI;
const processModule = pathToFileURL(
  join(process.cwd(), "dist/process.js"),
).href;
const TIER = "lightweight validation tier task-register";
const TIMEOUT = 120_000;
const temporaryRoots: string[] = [];
const children: ChildProcess[] = [];
const leases: QueueLease[] = [];

afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  for (const lease of leases.splice(0))
    await releaseBuildSlot(lease).catch(() => undefined);
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bypassBuildQueue configuration", () => {
  it("accepts booleans and rejects any other value", () => {
    const config = (tier: unknown, setup?: unknown): Config =>
      ({
        lockWaitSeconds: 900,
        repositories: [
          {
            path: "/work/repo",
            gitCommonDir: "/work/repo/.git",
            defaultBranch: "main",
            integrationBranch: "sesh-integrator/integration",
            setupCommands: [],
            sourceValidationCommands: [],
            integrationValidationCommands: [],
            postIntegrationCommands: [],
            conflictInstructions: "",
            ...(setup === undefined ? {} : { setupBypassBuildQueue: setup }),
            validationTiers: [
              {
                name: "task-register",
                paths: ["TASKS.json"],
                sourceValidationCommands: [],
                integrationValidationCommands: [],
                ...(tier === undefined ? {} : { bypassBuildQueue: tier }),
              },
            ],
          },
        ],
      }) as unknown as Config;
    for (const value of [undefined, true, false])
      expect(() => validateConfig(config(value, value), "test")).not.toThrow();
    for (const value of ["yes", 1, null, {}])
      expect(() => validateConfig(config(value), "test")).toThrow(
        "Invalid bypassBuildQueue in validation tier task-register for /work/repo: use true or false",
      );
    for (const value of ["true", 0, null])
      expect(() => validateConfig(config(true, value), "test")).toThrow(
        "Invalid setupBypassBuildQueue for /work/repo: use true or false",
      );
  });

  it("bypasses only for a batch whose members share a lightweight tier", () => {
    const repository = {
      sourceValidationCommands: [["full"]],
      integrationValidationCommands: [["full"]],
      validationTiers: [
        {
          name: "task-register",
          paths: ["tasks/*.json"],
          sourceValidationCommands: [["light"]],
          integrationValidationCommands: [["light"]],
          bypassBuildQueue: true,
        },
        {
          name: "docs",
          paths: ["**/*.md"],
          sourceValidationCommands: [],
          integrationValidationCommands: [["docs"]],
        },
      ],
    } as unknown as RepositoryConfig;
    const member = (path: string, tier: string): Session =>
      ({
        changedPaths: [path],
        validationTier: tier,
        readyCommit: "ready",
        sourceValidatedCommit: "ready",
      }) as unknown as Session;
    const light = batchValidation(repository, [
      member("tasks/a.json", "task-register"),
      member("tasks/b.json", "task-register"),
    ]);
    expect(light).toMatchObject({ name: "task-register" });
    expect(validationQueueBypass(light)).toBe(TIER);
    // A code member or a member of another tier selects the queued fallback.
    for (const other of [member("src/a.ts", "full"), member("a.md", "docs")]) {
      const mixed = batchValidation(repository, [
        member("tasks/a.json", "task-register"),
        other,
      ]);
      expect(mixed).toMatchObject({ name: "full", bypassBuildQueue: false });
      expect(validationQueueBypass(mixed)).toBeUndefined();
    }
  });
});

describe("bypassing a full build queue", () => {
  it("runs a lightweight plan at once while a normal plan keeps waiting", async () => {
    await queueConfig(1);
    const root = queueRoot();
    const events = join(root, "events");
    const release = join(root, "release-light");
    const holder = await holdSlot("full test suite");
    const normal = launch(
      `import {runValidation} from ${JSON.stringify(processModule)};await runValidation([${JSON.stringify(command("normal", events))}],${JSON.stringify(root)},{sessionId:'normal-tier'});`,
    );
    await until(async () =>
      (await queueEntries()).some(
        (e) => e.sessionId === "normal-tier" && e.state === "waiting",
      ),
    );
    const light = launch(
      `import {runValidation} from ${JSON.stringify(processModule)};await runValidation([${JSON.stringify(command("light", events, release))}],${JSON.stringify(root)},{sessionId:'light-tier',queueBypass:${JSON.stringify(TIER)}});`,
    );
    await until(async () => (await readEvents(events)).includes("light:start"));

    // Queue status names the bypassing command; it holds no slot.
    const status = await statusOutput();
    expect(status).toContain(
      `bypassed queue (${TIER}; no slot used): source validation; session light-tier`,
    );
    expect(
      (await queueEntries()).map((e) => [e.label, e.state]).sort(),
    ).toEqual([
      ["full test suite", "running"],
      ["source validation", "waiting"],
    ]);

    await writeFile(release, "go\n");
    const lightResult = await light.done;
    expect(lightResult.code, lightResult.output).toBe(0);
    expect(lightResult.output).toContain(
      `Build queue bypassed (${TIER}; no slot used): source validation [light-tier]`,
    );
    expect(lightResult.output).not.toContain("Build queue waiting");
    expect(await queueBypasses()).toEqual([]);
    // The normal plan never started while the slot stayed taken.
    expect(await readEvents(events)).not.toContain("normal:start");
    expect(
      (await queueEntries()).find((e) => e.sessionId === "normal-tier")?.state,
    ).toBe("waiting");

    await releaseBuildSlot(holder);
    leases.splice(leases.indexOf(holder), 1);
    const normalResult = await normal.done;
    expect(normalResult.code, normalResult.output).toBe(0);
    expect(normalResult.output).toContain(
      "Build queue running (1/1): source validation [normal-tier]",
    );
    expect(normalResult.output).not.toContain("Build queue bypassed");
    expect(await queueEntries()).toEqual([]);
  }, 30_000);

  it("records a failed lightweight command as bypassing, not running", async () => {
    await queueConfig(1);
    await holdSlot("full test suite");
    const failure = await quietly(() =>
      runValidation(
        [
          [
            process.execPath,
            "-e",
            "console.error('bad register');process.exit(4)",
          ],
        ],
        queueRoot(),
        // No session ID: keeps the full-output log out of the runtime home.
        { queueBypass: TIER },
      ),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ValidationFailure);
    expect((failure as ValidationFailure).record.queueLoad).toMatchObject({
      running: 1,
      waiting: 0,
      capacity: 1,
      bypassed: 1,
    });
    expect(await queueBypasses()).toEqual([]);
  });
});

describe.sequential("lightweight tiers in disposable repositories", () => {
  it(
    "validates and integrates a TASKS.json-only change while the queue is full; code and mixed changes wait for the queued full fallback",
    async () => {
      const fixture = await createFixture();
      await queueConfig(1, 120);
      const holder = await holdSlot("full test suite");

      const light = await beginSession(fixture, "light");
      commitFiles(light, { "TASKS.json": '{"tasks":[1]}\n' }, "light");
      const validated = await runCliOk(fixture, light, ["validate"]);
      expect(validated.stdout).toContain(
        "Validation tier: task-register (1 changed path(s)); lightweight, bypasses the build queue",
      );
      expect(validated.stdout).toContain(
        `Build queue bypassed (${TIER}; no slot used): source validation`,
      );
      // Setup opted in too, so integration never waits for the held slot.
      const integrated = await runCliOk(fixture, light, [
        "integrate",
        "--summary",
        "light done",
      ]);
      expect(integrated.stdout).toContain(
        "Build queue bypassed (lightweight setup commands; no slot used): setup command",
      );
      expect(integrated.stdout).toContain(
        `Build queue bypassed (${TIER}; no slot used): integration validation`,
      );
      expect(integrated.stdout).not.toContain("Build queue waiting");
      expect((await sessionFor(fixture, light)).status).toBe("succeeded");
      expect(await runs(fixture)).toEqual(["tier", "tier-integration"]);

      const code = await beginSession(fixture, "code");
      commitFiles(code, { "src/app.js": "export {};\n" }, "code");
      const codeRun = runCli(fixture, code, ["validate"]);
      await until(async () => (await waitingValidations()) === 1);
      const mixed = await beginSession(fixture, "mixed");
      commitFiles(
        mixed,
        { "TASKS.json": '{"tasks":[2]}\n', "src/other.js": "export {};\n" },
        "mixed",
      );
      const mixedRun = runCli(fixture, mixed, ["validate"]);
      await until(async () => (await waitingValidations()) === 2);
      expect(await queueBypasses()).toEqual([]);
      expect(await runs(fixture)).toEqual(["tier", "tier-integration"]);

      await releaseBuildSlot(holder);
      leases.splice(leases.indexOf(holder), 1);
      for (const result of await Promise.all([codeRun, mixedRun])) {
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("Validation tier: full");
        expect(result.stdout).toContain(
          "Build queue running (1/1): source validation",
        );
        expect(result.stdout).not.toContain("Build queue bypassed");
      }
      expect(await runs(fixture)).toEqual([
        "tier",
        "tier-integration",
        "full",
        "full",
      ]);
    },
    TIMEOUT,
  );

  it(
    "queues setup without the opt-in and post-integration checks for a lightweight tier",
    async () => {
      const fixture = await createFixture();
      const light = await beginSession(fixture, "light-post");
      commitFiles(light, { "TASKS.json": '{"tasks":[3]}\n' }, "light");
      await runCliOk(fixture, light, ["validate"]);
      await updateConfig(fixture, (config) => {
        delete config.repositories[0].setupBypassBuildQueue;
        config.repositories[0].postIntegrationCommands = [
          [process.execPath, "-e", "0"],
        ];
      });
      await queueConfig(1, 120);
      const holder = await holdSlot("full test suite");
      const integrating = runCli(fixture, light, [
        "integrate",
        "--summary",
        "light done",
      ]);
      await until(async () =>
        (await queueEntries()).some(
          (e) => e.label === "setup command" && e.state === "waiting",
        ),
      );
      await releaseBuildSlot(holder);
      leases.splice(leases.indexOf(holder), 1);
      const result = await integrating;
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "Build queue running (1/1): setup command",
      );
      expect(result.stdout).toContain(
        `Build queue bypassed (${TIER}; no slot used): integration validation`,
      );
      expect(result.stdout).toContain(
        "Build queue running (1/1): post-integration command",
      );
      expect(result.stdout).not.toContain("lightweight setup commands");
      expect((await sessionFor(fixture, light)).status).toBe("succeeded");
    },
    TIMEOUT,
  );

  it(
    "validates a batch of lightweight-tier sessions without a queue slot",
    async () => {
      const fixture = await createFixture();
      const blocker = await beginSession(fixture, "blocker");
      commitFiles(blocker, { "blocker.txt": "blocker\n" }, "blocker");
      const blocked = runCli(fixture, blocker, [
        "integrate",
        "--summary",
        "blocker done",
      ]);
      await waitFor(() => exists(fixture.gate), "blocker validation to start");
      const waiting: { worktree: string; result: Promise<CliResult> }[] = [];
      for (const name of ["batch-a", "batch-b"]) {
        const worktree = await beginSession(fixture, name);
        commitFiles(worktree, { [`tasks/${name}.json`]: "{}\n" }, name);
        await runCliOk(fixture, worktree, ["validate"]);
        const result = runCli(fixture, worktree, [
          "integrate",
          "--summary",
          `${name} done`,
        ]);
        await waitFor(async () => {
          const session = await sessionFor(fixture, worktree);
          return session?.waitingForLock === true && !!session.integrationWait;
        }, `${name} to wait for the repository lock`);
        waiting.push({ worktree, result });
      }
      await writeFile(fixture.release, "go\n");
      const results = await Promise.all([
        blocked,
        ...waiting.map((item) => item.result),
      ]);
      for (const result of results)
        expect(result.code, result.stdout + result.stderr).toBe(0);
      const members = await Promise.all(
        waiting.map((item) => sessionFor(fixture, item.worktree)),
      );
      expect(members[0].integrationBatch).toMatchObject({
        outcome: "batched",
        validationTier: "task-register",
      });
      expect(members[1].integrationBatch.id).toBe(
        members[0].integrationBatch.id,
      );
      const leader =
        results[
          1 +
            members.findIndex(
              (member) => member.integrationBatch.role === "leader",
            )
        ]!;
      const output = results.map((result) => result.stdout).join("\n---\n");
      expect(leader.stdout, output).toContain(
        "(tier task-register; lightweight, bypasses the build queue)",
      );
      expect(leader.stdout, output).toContain(
        `Build queue bypassed (${TIER}; no slot used): integration validation`,
      );
    },
    TIMEOUT,
  );

  it.skipIf(!legacyCli)(
    "keeps an older coordinator queueing with the new options",
    async () => {
      const fixture = await createFixture();
      const light = await beginSession(fixture, "legacy-light", legacyCli);
      commitFiles(light, { "TASKS.json": '{"tasks":[4]}\n' }, "legacy");
      const result = await runCli(fixture, light, ["validate"], {}, legacyCli);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Validation tier: task-register");
      expect(result.stdout).toContain("Build queue running");
      expect(result.stdout).not.toContain("Build queue bypassed");
    },
    TIMEOUT,
  );

  it("rejects invalid option values before running any command", async () => {
    const fixture = await createFixture();
    await updateConfig(fixture, (config) => {
      config.repositories[0].validationTiers[0].bypassBuildQueue = "yes";
    });
    const tier = await runCli(fixture, fixture.repo, ["status"]);
    expect(tier.code).toBe(1);
    expect(tier.stderr).toContain(
      "Invalid bypassBuildQueue in validation tier task-register",
    );
    await updateConfig(fixture, (config) => {
      config.repositories[0].validationTiers[0].bypassBuildQueue = true;
      config.repositories[0].setupBypassBuildQueue = 1;
    });
    const setup = await runCli(fixture, fixture.repo, ["status"]);
    expect(setup.code).toBe(1);
    expect(setup.stderr).toContain("Invalid setupBypassBuildQueue");
  });
});

/** A repository whose full plan blocks on blocker.txt until released. */
async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sesh-bypass-test-"));
  temporaryRoots.push(root);
  const fixture: Fixture = {
    root,
    repo: join(root, "repo"),
    runtime: join(root, "runtime"),
    home: join(root, "home"),
    log: join(root, "validation.log"),
    gate: join(root, "blocker-started"),
    release: join(root, "release-blocker"),
  };
  await mkdir(fixture.repo, { recursive: true });
  await mkdir(fixture.home, { recursive: true });
  git(fixture.repo, "init", "-b", "main");
  git(fixture.repo, "config", "user.name", "Test User");
  git(fixture.repo, "config", "user.email", "test@example.com");
  git(fixture.repo, "config", "commit.gpgSign", "false");
  await writeFile(join(fixture.repo, "TASKS.json"), '{"tasks":[]}\n');
  git(fixture.repo, "add", "TASKS.json");
  git(fixture.repo, "commit", "-m", "base");
  await runCliOk(fixture, fixture.repo, ["init"]);
  await runCliOk(fixture, fixture.repo, ["register"]);
  const recorder = join(root, "record.cjs");
  await writeFile(
    recorder,
    `const fs = require("node:fs");
const [log, kind, gate, release] = process.argv.slice(2);
if (gate && fs.existsSync("blocker.txt") && !fs.existsSync(release)) {
  fs.writeFileSync(gate, "started\\n");
  const started = Date.now();
  while (!fs.existsSync(release) && Date.now() - started < 60000)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
fs.appendFileSync(log, kind + "\\n");
`,
  );
  const full = [
    [
      process.execPath,
      recorder,
      fixture.log,
      "full",
      fixture.gate,
      fixture.release,
    ],
  ];
  // Distinct integration commands keep exact-tree source results from being
  // reused, so integration really runs (and bypasses) its tier commands.
  const tier = [[process.execPath, recorder, fixture.log, "tier"]];
  const tierIntegration = [
    [process.execPath, recorder, fixture.log, "tier-integration"],
  ];
  await updateConfig(fixture, (config) => {
    config.lockWaitSeconds = 90;
    const repository = config.repositories[0];
    repository.setupCommands = [[process.execPath, "-e", "0"]];
    repository.setupBypassBuildQueue = true;
    repository.sourceValidationCommands = full;
    repository.integrationValidationCommands = full;
    repository.validationTiers = [
      {
        name: "task-register",
        paths: ["TASKS.json", "tasks/*.json"],
        sourceValidationCommands: tier,
        integrationValidationCommands: tierIntegration,
        bypassBuildQueue: true,
      },
    ];
  });
  return fixture;
}

async function beginSession(
  fixture: Fixture,
  name: string,
  executable = cli,
): Promise<string> {
  const path = join(fixture.root, name);
  git(fixture.repo, "worktree", "add", "-b", name, path, "main");
  const worktree = await realpath(path);
  const begun = await runCli(
    fixture,
    worktree,
    ["begin", "--summary", name],
    {},
    executable,
  );
  expect(begun.code, begun.stdout + begun.stderr).toBe(0);
  return worktree;
}

function commitFiles(
  worktree: string,
  files: Record<string, string>,
  message: string,
): void {
  for (const [name, contents] of Object.entries(files)) {
    execFileSync(process.execPath, [
      "-e",
      `const fs=require('fs');const p=require('path');const f=${JSON.stringify(join(worktree, name))};fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,${JSON.stringify(contents)})`,
    ]);
    git(worktree, "add", name);
  }
  git(worktree, "commit", "-m", message);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function runCli(
  fixture: Fixture,
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  executable = cli,
): Promise<CliResult> {
  const effective =
    args[0] === "integrate" ? [...args, "--rollout", "none"] : args;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...effective], {
      cwd,
      env: {
        ...process.env,
        PARALLEL_INTEGRATOR_HOME: fixture.runtime,
        PARALLEL_INTEGRATOR_AUDIT_HOME: fixture.home,
        PARALLEL_INTEGRATOR_DOCTOR_HOME: fixture.home,
        PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function runCliOk(
  fixture: Fixture,
  cwd: string,
  args: string[],
): Promise<CliResult> {
  const result = await runCli(fixture, cwd, args);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return result;
}

async function updateConfig(
  fixture: Fixture,
  mutate: (config: any) => void,
): Promise<void> {
  const path = join(fixture.runtime, "config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  mutate(config);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function sessionFor(fixture: Fixture, worktree: string): Promise<any> {
  const directory = join(fixture.runtime, "sessions");
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    try {
      const session = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (session.worktreePath === worktree) return session;
    } catch {
      // Mid-write; the next poll reads it.
    }
  }
  return undefined;
}

async function runs(fixture: Fixture): Promise<string[]> {
  try {
    return (await readFile(fixture.log, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitingValidations(): Promise<number> {
  return (await queueEntries()).filter(
    (e) => e.label === "source validation" && e.state === "waiting",
  ).length;
}

async function queueConfig(concurrency: number, waitSeconds = 30) {
  await writeFile(
    join(queueRoot(), "config.json"),
    JSON.stringify({ concurrency, waitSeconds }),
  );
}

async function holdSlot(label: string): Promise<QueueLease> {
  const lease = await quietly(() =>
    acquireBuildSlot(
      queueRoot(),
      label,
      "holder",
      new AbortController().signal,
    ),
  );
  leases.push(lease);
  return lease;
}

/** Records start/end events; with `release`, runs until that file exists. */
function command(
  id: string,
  events: string,
  release?: string,
): [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `const fs=require('fs');const p=${JSON.stringify(events)};fs.appendFileSync(p,${JSON.stringify(id)}+':start\\n');const r=${JSON.stringify(release ?? "")};const t=setInterval(()=>{if(!r||fs.existsSync(r)){clearInterval(t);fs.appendFileSync(p,${JSON.stringify(id)}+':end\\n');}},25);`,
  ];
}

async function readEvents(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function launch(source: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => (output += String(chunk)));
  child.stderr!.on("data", (chunk) => (output += String(chunk)));
  const done = new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    },
  );
  return { child, done };
}

async function statusOutput(): Promise<string> {
  let output = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });
  try {
    await queueCommand(["status"]);
  } finally {
    spy.mockRestore();
  }
  return output;
}

/** Keep in-process queue and validation messages out of the test output. */
async function quietly<T>(action: () => Promise<T>): Promise<T> {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return await action();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

async function until(predicate: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for fixture state");
}

async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
