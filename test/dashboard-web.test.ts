import { afterEach, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import {
  parseWebOptions,
  startWebDashboard,
  webActionArguments,
  webRevision,
  webRow,
  runWebCommand,
} from "../src/dashboard-web.js";
import type { DashboardRow } from "../src/dashboard.js";
import { defaultConfig, repoId } from "../src/runtime.js";

const servers: Awaited<ReturnType<typeof startWebDashboard>>[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});
function row(): DashboardRow {
  return {
    repository: {
      path: "/repo",
      gitCommonDir: "/repo/.git",
      defaultBranch: "main",
      integrationBranch: "staging",
      setupCommands: [],
      sourceValidationCommands: [],
      integrationValidationCommands: [],
      postIntegrationCommands: [],
      conflictInstructions: "",
    },
    session: {
      id: "session_web",
      repositoryId: "repo",
      repositoryPath: "/repo",
      worktreePath: "/source",
      branch: "task",
      status: "active",
      startCommit: "base",
      integrationCommitAtStart: null,
      startedAt: "2026-09-20T12:00:00Z",
      taskSummary: "Build dashboard",
      dependsOn: [],
    },
  };
}
async function start(options: Parameters<typeof startWebDashboard>[0] = {}) {
  const server = await startWebDashboard({
    load: async () => [row()],
    watch: () => () => {},
    ...options,
  });
  servers.push(server);
  return server;
}
async function post(
  server: Awaited<ReturnType<typeof startWebDashboard>>,
  value: unknown,
  headers = {},
) {
  return fetch(server.url + "/api/action", {
    method: "POST",
    headers: {
      Origin: server.url,
      "Content-Type": "application/json",
      "X-Sesh-Dashboard": "1",
      ...headers,
    },
    body: JSON.stringify(value),
  });
}
it("parses only explicit local web options and validates ports", () => {
  expect(parseWebOptions(["--web"])).toEqual({ port: 0, open: true });
  expect(parseWebOptions(["--web", "--no-open", "--port", "3456"])).toEqual({
    port: 3456,
    open: false,
  });
  for (const args of [
    ["--no-open"],
    ["--web", "--remote"],
    ["--web", "--web"],
    ["--web", "--port", "0"],
    ["--web", "--port", "65536"],
    ["--web", "--port", "1.5"],
  ])
    expect(() => parseWebOptions(args)).toThrow();
});
it("browses an absent runtime without creating state and serves offline assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-dashboard-"));
  roots.push(root);
  vi.stubEnv("SESH_INTEGRATOR_HOME", join(root, "absent"));
  const server = await startWebDashboard();
  servers.push(server);
  const response = await fetch(server.url + "/api/state");
  expect(response.status).toBe(200);
  expect((await response.json()).rows).toEqual([]);
  const page = await fetch(server.url);
  expect(page.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(await page.text()).toContain("Search sessions");
  expect(
    (await fetch(server.url + "/app.js")).headers.get("content-type"),
  ).toContain("javascript");
  expect((await fetch(server.url + "/app.css")).status).toBe(200);
  expect((await fetch(server.url + "/../../config.json")).status).toBe(404);
  expect(await readdir(root)).toEqual([]);
});
it("blocks DNS rebinding, cross-site reads and forged action requests", async () => {
  const run = vi.fn();
  const server = await start({ run });
  const response = await new Promise<number>((resolve) => {
    const req = request(
      server.url + "/api/state",
      { headers: { Host: "attacker.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.end();
  });
  expect(response).toBe(403);
  expect(
    (
      await fetch(server.url + "/api/state", {
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(server.url + "/api/state", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await post(server, {}, { Origin: "https://attacker.example" })).status,
  ).toBe(403);
  expect(
    (await fetch(server.url + "/api/action", { method: "POST", body: "{}" }))
      .status,
  ).toBe(403);
  expect((await post(server, {}, { "X-Sesh-Dashboard": "0" })).status).toBe(
    403,
  );
  expect(run).not.toHaveBeenCalled();
});
it("uses selected projections, preserves Unicode and rejects unsafe PR URLs", () => {
  const sample = row();
  sample.session!.taskSummary = "<script>alert(1)</script> 日本語";
  sample.session!.pullRequestUrl = "javascript:alert(1)";
  const view = webRow(sample);
  expect(view.title).toContain("日本語");
  expect(view.pullRequestUrl).toBeUndefined();
  expect(view).not.toHaveProperty("repository.sourceValidationCommands");
});
it("rechecks action gating and stale session/configuration revisions", () => {
  const sample = row();
  const revision = webRevision(sample);
  expect(
    webActionArguments(sample, {
      action: "validate",
      session: "session_web",
      revision,
    }),
  ).toEqual(["validate", "--session", "session_web"]);
  sample.repository!.targetBranch = "dev";
  expect(() =>
    webActionArguments(sample, {
      action: "validate",
      session: "session_web",
      revision,
    }),
  ).toThrow("changed");
  sample.session!.status = "succeeded";
  expect(() =>
    webActionArguments(sample, {
      action: "validate",
      session: "session_web",
      revision: webRevision(sample),
    }),
  ).toThrow("already integrated");
});
it("validates integration rollout and task inputs without accepting arbitrary commands", () => {
  const sample = row();
  sample.session!.sourceValidatedCommit = "commit";
  const base = { session: "session_web", revision: webRevision(sample) };
  expect(() =>
    webActionArguments(sample, {
      ...base,
      action: "integrate",
      input: { summary: "Done", rollout: "manual", followUps: [] },
    }),
  ).toThrow("follow-up");
  expect(
    webActionArguments(sample, {
      ...base,
      action: "integrate",
      input: { summary: "Done", rollout: "none", followUps: [] },
    }),
  ).toEqual([
    "integrate",
    "--session",
    "session_web",
    "--summary",
    "Done",
    "--rollout",
    "none",
  ]);
  expect(() =>
    webActionArguments(sample, { ...base, action: "shell" }),
  ).toThrow();
  expect(
    webActionArguments(sample, {
      ...base,
      action: "task-add",
      task: { title: "One task" },
    }),
  ).toContain("One task");
  expect(() =>
    webActionArguments(sample, {
      ...base,
      action: "task-update",
      task: { id: 99, status: "completed" },
    }),
  ).toThrow();
});
it("serializes commands and waits for completion before closing", async () => {
  let finish!: (code: number) => void;
  const run = vi.fn(async (_row, _args, output) => {
    output("\u001b[31mChecking\u001b[0m");
    return new Promise<number>((resolve) => {
      finish = resolve;
    });
  });
  const server = await start({ run });
  const body = {
    session: "session_web",
    revision: webRevision(row()),
    action: "validate",
  };
  expect((await post(server, body)).status).toBe(202);
  expect((await post(server, body)).status).toBe(409);
  const state = await (await fetch(server.url + "/api/state")).json();
  expect(state.job.output).toBe("Checking");
  expect(state.job.running).toBe(true);
  let closed = false;
  const close = server.close().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(closed).toBe(false);
  finish(0);
  await close;
  expect(run).toHaveBeenCalledOnce();
});
it("reports command failures without losing browsing and bounds output", async () => {
  const server = await start({
    run: async (_row, _args, output) => {
      output("x".repeat(200_000));
      throw Error("Cannot run command");
    },
  });
  expect(
    (
      await post(server, {
        session: "session_web",
        revision: webRevision(row()),
        action: "validate",
      })
    ).status,
  ).toBe(202);
  const state = await (await fetch(server.url + "/api/state")).json();
  expect(state.job.running).toBe(false);
  expect(state.job.code).toBe(1);
  expect(state.job.output).toContain("Cannot run command");
  expect(state.job.output.length).toBeLessThan(132_000);
});
it("streams change notifications and releases its watcher and sockets on close", async () => {
  let change!: () => void;
  const stop = vi.fn();
  const server = await start({
    watch: (callback) => {
      change = callback;
      return stop;
    },
  });
  const response = await fetch(server.url + "/api/events");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "event: change",
  );
  change();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "event: change",
  );
  await server.close();
  expect(stop).toHaveBeenCalledOnce();
  expect((await reader.read()).done).toBe(true);
});
it("runs checklist edits through the actual CLI in a disposable Git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-command-"));
  roots.push(root);
  const repo = join(root, "repo"),
    runtime = join(root, "runtime");
  await mkdir(repo);
  await mkdir(join(runtime, "sessions"), { recursive: true });
  vi.stubEnv("SESH_INTEGRATOR_HOME", runtime);
  expect(spawnSync("git", ["init", "-b", "task", repo]).status).toBe(0);
  expect(
    spawnSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    ]).status,
  ).toBe(0);
  const sample = row();
  Object.assign(sample.repository!, {
    path: repo,
    gitCommonDir: join(repo, ".git"),
  });
  Object.assign(sample.session!, {
    repositoryPath: repo,
    repositoryId: repoId(join(repo, ".git")),
    worktreePath: repo,
    startCommit: spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim(),
  });
  await writeFile(
    join(runtime, "config.json"),
    JSON.stringify({ ...defaultConfig(), repositories: [sample.repository] }),
  );
  await writeFile(
    join(runtime, "sessions", "session_web.json"),
    JSON.stringify(sample.session),
  );
  sample.session!.coordinator = {
    cliPath: resolve("dist/cli.js"),
    buildId: "fixture",
    version: "0.1.0",
    stateContract: 1,
    recoveryContract: 1,
  };
  const output: string[] = [];
  const code = await runWebCommand(
    sample,
    ["tasks", "add", "--session", "session_web", "--title", "Browser task"],
    (s) => output.push(s),
  );
  expect(code, output.join("")).toBe(0);
  expect(output.join("")).toContain("Browser task");
});
it("starts without a terminal and exits cleanly on SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-cli-"));
  roots.push(root);
  const child = spawn(
    process.execPath,
    [resolve("dist/cli.js"), "dashboard", "--web", "--no-open"],
    {
      env: { ...process.env, SESH_INTEGRATOR_HOME: root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(Error("Startup timed out")),
        5000,
      );
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });
      child.once("error", reject);
    });
    expect((await fetch(url)).status).toBe(200);
    const closed = once(child, "close");
    child.kill("SIGTERM");
    expect((await closed)[0]).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});

it("preserves UTF-8 characters split across HTTP request chunks", async () => {
  const run = vi.fn(async () => 0);
  const server = await start({ run });
  const title = "日本語 task";
  const body = Buffer.from(
    JSON.stringify({
      session: "session_web",
      revision: webRevision(row()),
      action: "task-add",
      task: { title },
    }),
  );
  const boundary = body.indexOf(Buffer.from("日")) + 1;
  const code = await new Promise<number>((resolve, reject) => {
    const req = request(
      server.url + "/api/action",
      {
        method: "POST",
        headers: {
          Origin: server.url,
          "Content-Type": "application/json",
          "X-Sesh-Dashboard": "1",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", reject);
    req.write(body.subarray(0, boundary));
    setTimeout(() => req.end(body.subarray(boundary)), 15);
  });
  expect(code).toBe(202);
  expect(run.mock.calls[0]![1]).toContain(title);
});
