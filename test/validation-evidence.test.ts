import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireBuildSlot,
  queueRoot,
  releaseBuildSlot,
} from "../src/build-queue.js";
import { incidentCommand, incidentFingerprint } from "../src/incident.js";
import { ValidationFailure, runValidation } from "../src/process.js";
import { redactSecrets } from "../src/redaction.js";
import type { Session, ValidationFailureRecord } from "../src/types.js";
import {
  boundedTail,
  failureSignature,
  outputTailBytes,
  outputTailLines,
  sampleQueueLoad,
} from "../src/validation-output.js";
import {
  boundedWorkers,
  resolveTestWorkers,
  testWorkersVariable,
} from "../src/worker-budget.js";

const roots: string[] = [];
const cli = join(process.cwd(), "dist", "cli.js");

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// A secret-looking environment value and token shapes that must never be
// persisted. They are synthetic test values, not credentials.
const fakeSecret = "fake-value-for-redaction-0123456789";
const fakeGithubToken = `ghp_${"a1B2c3D4e5".repeat(4)}`;

function failingScript(lines = 200): string {
  // Secret-shaped values are assembled at run time so the command line itself
  // (which the failure record keeps) never contains them.
  return [
    `for (let i = 0; i < ${lines}; i++) console.log("progress line " + i);`,
    `console.log("Authorization: Bearer " + "abcdefghijklmnop" + "0123");`,
    `console.log("clone https://ci-user:" + "hunter2".repeat(2) + "@example.invalid/repo.git");`,
    `console.error(" FAIL  test/b.test.ts > other > times out 30001ms");`,
    `console.error(" FAIL  test/a.test.ts > suite > breaks under load");`,
    `console.error("token=" + process.env.SESH_FAKE_SERVICE_TOKEN);`,
    `console.error("pushing with ghp_" + "a1B2c3D4e5".repeat(4));`,
    `console.error("Error: Test timed out in 30000ms.");`,
    `process.exit(3);`,
  ].join("\n");
}

describe("vitest worker bound", () => {
  it("divides the CPUs between concurrent queued commands", () => {
    expect(boundedWorkers(16, 1)).toBe(15);
    expect(boundedWorkers(16, 2)).toBe(7);
    expect(boundedWorkers(16, 4)).toBe(3);
    expect(boundedWorkers(8, 64)).toBe(1);
    expect(boundedWorkers(1, 1)).toBe(1);
  });

  it("derives the bound from the effective queue concurrency", async () => {
    // test/queue-isolation.ts configures an isolated queue with concurrency 2.
    expect(await resolveTestWorkers({}, 16)).toEqual({
      maxWorkers: 7,
      source: "16 CPUs / build queue concurrency 2",
    });
    await writeFile(
      join(queueRoot(), "config.json"),
      JSON.stringify({ concurrency: 4, waitSeconds: 30 }),
    );
    expect((await resolveTestWorkers({}, 16)).maxWorkers).toBe(3);
  });

  it("uses the resource-aware estimate for an unlimited or invalid queue", async () => {
    await writeFile(
      join(queueRoot(), "config.json"),
      JSON.stringify({ concurrency: "unlimited", waitSeconds: 30 }),
    );
    const unlimited = await resolveTestWorkers({}, 16);
    expect(unlimited.source).toMatch(
      /unlimited build queue; resource-aware estimate \d+/,
    );
    expect(unlimited.maxWorkers).toBeLessThanOrEqual(15);
    await writeFile(join(queueRoot(), "config.json"), "{");
    expect((await resolveTestWorkers({}, 16)).source).toContain(
      "unreadable build queue settings",
    );
  });

  it("honours and validates the environment override", async () => {
    expect(
      await resolveTestWorkers({ [testWorkersVariable]: " 5 " }, 16),
    ).toEqual({ maxWorkers: 5, source: testWorkersVariable });
    for (const value of ["0", "abc", "2.5", "50%"])
      await expect(
        resolveTestWorkers({ [testWorkersVariable]: value }, 16),
      ).rejects.toThrow(`${testWorkersVariable} must be a whole number`);
  });

  it("applies the bound in the repository vitest config", async () => {
    const config = (await import("../vitest.config.js")).default as unknown as (
      env: unknown,
    ) => Promise<{ test: { maxWorkers: number; setupFiles: string[] } }>;
    const derived = await config({ command: "serve", mode: "test" });
    expect(derived.test.maxWorkers).toBe(
      boundedWorkers(availableParallelism(), 2),
    );
    expect(derived.test.setupFiles).toEqual(["./test/queue-isolation.ts"]);
    vi.stubEnv(testWorkersVariable, "3");
    expect(
      (await config({ command: "serve", mode: "test" })).test.maxWorkers,
    ).toBe(3);
  });
});

describe("failure output evidence", () => {
  it("redacts secret environment values and common credential shapes", () => {
    const text = [
      `value ${fakeSecret} leaked`,
      `Authorization: Bearer abcdefghijklmnop0123`,
      `curl -H "authorization: token zyxwvutsrqponmlk"`,
      `https://user:p4ssw0rd-long@example.invalid/x`,
      `https://bucket.example.invalid/o?X-Amz-Signature=abcdef0123456789&ok=1`,
      `${fakeGithubToken} and AKIAABCDEFGHIJKLMNOP`,
      `password=correct-horse "api_key": "abcd1234efgh"`,
      `-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----`,
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop`,
      `cwd /home/dev/project ok`,
    ].join("\n");
    const redacted = redactSecrets(text, {
      SESH_FAKE_SERVICE_TOKEN: fakeSecret,
      PWD: "/home/dev/project",
      GIT_AUTHOR_EMAIL: "someone@example.invalid",
      SHORT_TOKEN: "abc",
    });
    for (const secret of [
      fakeSecret,
      "abcdefghijklmnop0123",
      "zyxwvutsrqponmlk",
      "p4ssw0rd-long",
      "abcdef0123456789",
      fakeGithubToken,
      "AKIAABCDEFGHIJKLMNOP",
      "correct-horse",
      "abcd1234efgh",
      "AAAAB3Nza",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    ])
      expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[REDACTED:SESH_FAKE_SERVICE_TOKEN]");
    expect(redacted).toContain("cwd /home/dev/project ok");
    expect(redacted).toContain("&ok=1");
    expect(redacted).toContain("https://user:[REDACTED]@example.invalid/x");
  });

  it("bounds the tail by lines and bytes without splitting characters", () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const tail = boundedTail(many);
    expect(tail.truncated).toBe(true);
    expect(tail.text.split("\n")).toHaveLength(outputTailLines);
    expect(tail.text.endsWith("line 499")).toBe(true);
    const wide = boundedTail("é".repeat(10_000));
    expect(Buffer.byteLength(wide.text)).toBeLessThanOrEqual(outputTailBytes);
    expect(wide.text).toMatch(/^é+$/);
    expect(boundedTail("short\n")).toEqual({ text: "short", truncated: false });
  });

  it("extracts failing test names, or else the first error line", () => {
    expect(
      failureSignature(
        "   × suite > a 12ms\n",
        " FAIL  test/z.test.ts > z\n FAIL  test/a.test.ts > suite > a\n FAIL  test/z.test.ts > z\n",
      ),
    ).toEqual({
      failingTests: ["test/a.test.ts > suite > a", "test/z.test.ts > z"],
    });
    expect(failureSignature("   × suite > slow 30001ms\n", "")).toEqual({
      failingTests: ["suite > slow"],
    });
    // Another tool's "FAIL <check>" line is not a failing test heading.
    expect(
      failureSignature("FAIL  signing: gpg unavailable\nError: no key\n", ""),
    ).toEqual({ firstErrorLine: "Error: no key" });
    expect(
      failureSignature(
        "",
        "> pkg@1.0.0 typecheck\nsrc/a.ts(3,7): error TS2322: Type 'string' is not assignable.\n ELIFECYCLE  Command failed with exit code 2.\n",
      ),
    ).toEqual({
      firstErrorLine:
        "src/a.ts(3,7): error TS2322: Type 'string' is not assignable.",
    });
    expect(
      failureSignature("", " ELIFECYCLE  Command failed with exit code 1.\n"),
    ).toEqual({});
  });

  it("keeps a redacted tail, full log and queue load in the failure record", async () => {
    const root = await temporary("sesh-validation-evidence-");
    vi.stubEnv("SESH_INTEGRATOR_HOME", join(root, "runtime"));
    vi.stubEnv("SESH_FAKE_SERVICE_TOKEN", fakeSecret);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Another queued command keeps running while this validation fails.
    const other = await acquireBuildSlot(
      root,
      "other validation",
      "session_other",
      new AbortController().signal,
    );
    let error: unknown;
    try {
      error = await runValidation(
        [[process.execPath, "-e", failingScript()]],
        root,
        { sessionId: "session_evidence", phase: "integration" },
      ).catch((value) => value);
    } finally {
      await releaseBuildSlot(other);
    }
    expect(error).toBeInstanceOf(ValidationFailure);
    const record = (error as ValidationFailure).record;
    expect(record).toMatchObject({
      phase: "integration",
      exitCode: 3,
      message: `Validation failed (3): ${process.execPath} -e ${failingScript()}`,
      failingTests: [
        "test/a.test.ts > suite > breaks under load",
        "test/b.test.ts > other > times out",
      ],
      queueLoad: { running: 2, waiting: 0, capacity: 2 },
    });
    expect(record.firstErrorLine).toBeUndefined();
    expect(record.outputTail?.truncated).toBe(true);
    expect(record.outputTail?.stdout.split("\n")).toHaveLength(outputTailLines);
    expect(record.outputTail?.stdout).toContain("progress line 199");
    expect(record.outputTail?.stderr).toContain(
      "Error: Test timed out in 30000ms.",
    );
    expect(record.outputTail?.stderr).toContain(
      "token=[REDACTED:SESH_FAKE_SERVICE_TOKEN]",
    );
    expect(
      record.logPath?.startsWith(join(root, "runtime", "logs", "validation")),
    ).toBe(true);
    const log = await readFile(record.logPath!, "utf8");
    expect(log).toContain("progress line 0\n");
    expect(log).toContain("exit code: 3");
    expect((await stat(record.logPath!)).mode & 0o777).toBe(0o600);
    for (const text of [JSON.stringify(record), log]) {
      expect(text).not.toContain(fakeSecret);
      expect(text).not.toContain(fakeGithubToken);
      expect(text).not.toContain("abcdefghijklmnop0123");
      expect(text).not.toContain("hunter2hunter2");
    }
  });

  it("keeps only the in-record tail without a session and samples an idle queue", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = await runValidation(
      [[process.execPath, "-e", failingScript(2)]],
      queueRoot(),
    ).catch((value) => value);
    const record = (error as ValidationFailure).record;
    expect(record.logPath).toBeUndefined();
    expect(record.outputTail?.truncated).toBe(false);
    expect(record.outputTail?.stdout).toContain("progress line 0");
    expect(record.queueLoad).toMatchObject({
      running: 1,
      waiting: 0,
      capacity: 2,
    });
    // A command that never ran is not counted and has no output evidence.
    const missing = await runValidation(
      [[join(queueRoot(), "missing-command")]],
      queueRoot(),
    ).catch((value) => value);
    expect((missing as ValidationFailure).record).toMatchObject({
      queueLoad: { running: 0, waiting: 0, capacity: 2 },
    });
    expect((missing as ValidationFailure).record.exitCode).toBeUndefined();
    expect((missing as ValidationFailure).record.outputTail).toBeUndefined();
    await writeFile(
      join(queueRoot(), "config.json"),
      JSON.stringify({ concurrency: 0, waitSeconds: 30 }),
    );
    expect((await sampleQueueLoad(false)).unavailable).toContain(
      "Invalid build queue config",
    );
  });
});

describe("incident fingerprint", () => {
  function failure(
    overrides: Partial<ValidationFailureRecord> = {},
  ): ValidationFailureRecord {
    return {
      phase: "source",
      command: ["corepack", "pnpm", "run", "test"],
      classification: "unclassified",
      attempts: 1,
      maxAttempts: 1,
      exhausted: true,
      sharedResources: [],
      exclusiveResources: [],
      failedAt: "2026-10-20T00:00:00.000Z",
      message: "Validation failed (1): corepack pnpm run test",
      ...overrides,
    };
  }
  function session(validationFailure?: ValidationFailureRecord): Session {
    return {
      id: "session_test",
      status: "active",
      repositoryPath: "/repo",
      repositoryId: "repo",
      worktreePath: "/repo",
      branch: "task",
      startCommit: "aaaa",
      integrationCommitAtStart: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      taskSummary: "task",
      dependsOn: [],
      ...(validationFailure ? { validationFailure } : {}),
    } as Session;
  }
  const error = "Validation failed (1): corepack pnpm run test";
  const legacy = (status: string, value: string) =>
    createHash("sha256")
      .update(
        `${status}\0none\0${value.replace(/[0-9a-f]{7,40}/gi, "<sha>").replace(/\d+/g, "<n>")}`,
      )
      .digest("hex")
      .slice(0, 12);

  it("separates unrelated failures of the same command and exit code", () => {
    const a = incidentFingerprint(
      session(failure({ failingTests: ["test/a.test.ts > a"] })),
      error,
    );
    const b = incidentFingerprint(
      session(failure({ failingTests: ["test/b.test.ts > b"] })),
      error,
    );
    const typecheck = incidentFingerprint(
      session(failure({ firstErrorLine: "src/a.ts(1,1): error TS2322: x" })),
      error,
    );
    expect(new Set([a, b, typecheck]).size).toBe(3);
    expect(a).not.toBe(legacy("active", error));
    // Digits and SHAs are normalised, so a recurrence groups together.
    expect(
      incidentFingerprint(
        session(failure({ failingTests: ["test/a.test.ts > a"] })),
        error,
      ),
    ).toBe(a);
    expect(
      incidentFingerprint(
        session(failure({ firstErrorLine: "src/a.ts(9,4): error TS2322: x" })),
        error,
      ),
    ).toBe(typecheck);
  });

  it("keeps previous fingerprints without output evidence or for other errors", () => {
    expect(incidentFingerprint(session(failure()), error)).toBe(
      legacy("active", error),
    );
    // A stale record from an earlier attempt does not describe a later error.
    const later = "Repository lock wait exceeded 900s";
    expect(
      incidentFingerprint(
        session(failure({ failingTests: ["test/a.test.ts > a"] })),
        later,
      ),
    ).toBe(legacy("active", later));
  });
});

describe("validation failure through the CLI", () => {
  it("preserves evidence in the session, its incident and status", async () => {
    const root = await temporary("sesh-validation-cli-");
    const repo = join(root, "repo");
    const runtime = join(root, "runtime");
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgSign", "false");
    await writeFile(join(repo, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-m", "base");
    const env = {
      ...process.env,
      PARALLEL_INTEGRATOR_HOME: runtime,
      PARALLEL_INTEGRATOR_AUDIT_HOME: join(root, "home"),
      PARALLEL_INTEGRATOR_DOCTOR_HOME: join(root, "home"),
      PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
      SESH_FAKE_SERVICE_TOKEN: fakeSecret,
    };
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [cli, ...args], {
            cwd: repo,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.once("error", reject);
          child.once("close", (code) =>
            resolve({ code: code ?? 1, stdout, stderr }),
          );
        },
      );
    for (const args of [
      ["init"],
      ["register"],
      ["begin", "--summary", "evidence task"],
    ]) {
      const result = await run(args);
      expect(result.code, result.stderr).toBe(0);
    }
    const configPath = join(runtime, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.repositories[0].sourceValidationCommands = [
      [process.execPath, "-e", failingScript()],
    ];
    await writeFile(configPath, JSON.stringify(config, null, 2));
    await writeFile(join(repo, "task.txt"), "task\n");
    git("add", "task.txt");
    git("commit", "-m", "task");

    const failed = await run(["validate"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Validation failure evidence");
    expect(failed.stderr).toContain("build queue 1 running, 0 waiting");

    const sessionsDir = join(runtime, "sessions");
    const [sessionName] = (await readdir(sessionsDir)).filter((name) =>
      name.endsWith(".json"),
    );
    const sessionText = await readFile(join(sessionsDir, sessionName!), "utf8");
    const stored = JSON.parse(sessionText) as Session;
    const record = stored.validationFailure!;
    expect(record.failingTests).toEqual([
      "test/a.test.ts > suite > breaks under load",
      "test/b.test.ts > other > times out",
    ]);
    expect(record.queueLoad).toMatchObject({ running: 1, capacity: 2 });
    expect(record.outputTail?.stderr).toContain("Error: Test timed out");
    expect(
      record.logPath?.startsWith(join(runtime, "logs", "validation")),
    ).toBe(true);

    const incidentPath = join(
      runtime,
      "incidents",
      `${stored.latestIncidentId}.json`,
    );
    const incidentText = await readFile(incidentPath, "utf8");
    const incident = JSON.parse(incidentText);
    expect(incident.evidence.validationFailure).toEqual(record);
    expect(incident.fingerprint).toBe(
      incidentFingerprint(stored, incident.error),
    );
    for (const text of [
      sessionText,
      incidentText,
      await readFile(record.logPath!, "utf8"),
    ]) {
      expect(text).not.toContain(fakeSecret);
      expect(text).not.toContain(fakeGithubToken);
    }

    const status = await run(["status"]);
    expect(status.stdout).toContain(
      "  failing tests: test/a.test.ts > suite > breaks under load; test/b.test.ts > other > times out",
    );
    expect(status.stdout).toContain(
      "  build queue at failure: 1 running, 0 waiting (capacity 2)",
    );
    expect(status.stdout).toContain(`  full output log: ${record.logPath}`);

    vi.stubEnv("SESH_INTEGRATOR_HOME", runtime);
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    await incidentCommand(stored.latestIncidentId!);
    expect(lines.join("")).toContain(`Full output log: ${record.logPath}`);
    expect(lines.join("")).toContain("Build queue at failure: 1 running");
  });
});
