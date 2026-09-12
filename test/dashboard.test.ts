import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  actionArguments,
  actionReason,
  detailLines,
  loadDashboard,
  renderDashboard,
  terminalText,
  wrapLines,
  type DashboardRow,
} from "../src/dashboard.js";
import { defaultConfig } from "../src/runtime.js";

const roots: string[] = [];
afterEach(async () => {
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
      id: "session_example",
      repositoryId: "repo",
      repositoryPath: "/repo",
      worktreePath: "/source",
      branch: "task",
      status: "active",
      startCommit: "base",
      integrationCommitAtStart: null,
      startedAt: "2026-09-12",
      taskSummary: "Implement dashboard",
      dependsOn: [],
    },
  };
}
async function runtime() {
  const root = await mkdtemp(join(tmpdir(), "dashboard-test-"));
  roots.push(root);
  const path = join(root, "runtime");
  vi.stubEnv("PARALLEL_INTEGRATOR_HOME", path);
  return { root, path };
}
it("browses an absent runtime without creating it", async () => {
  const { root } = await runtime();
  expect(await loadDashboard()).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});
it("includes empty repositories and orphan sessions, inherits target policy, and does not write", async () => {
  const { path } = await runtime();
  await mkdir(join(path, "sessions"), { recursive: true });
  const sample = row();
  const config = JSON.stringify({
    ...defaultConfig(),
    defaultTargetBranch: "dev",
    repositories: [sample.repository],
  });
  await writeFile(join(path, "config.json"), config);
  sample.session!.repositoryPath = "/orphan";
  await writeFile(
    join(path, "sessions", "fixture.json"),
    JSON.stringify(sample.session),
  );
  const rows = await loadDashboard();
  expect(rows).toHaveLength(2);
  expect(rows[1]!.session).toBeUndefined();
  expect(detailLines(rows[1]!)).toContain("Target: dev");
  expect(actionReason(rows[0]!, "resume")).toContain("no longer registered");
  expect(await readFile(join(path, "config.json"), "utf8")).toBe(config);
  expect((await readdir(path)).sort()).toEqual(["config.json", "sessions"]);
});
it("orders all sessions newest first across repositories, including orphan sessions", async () => {
  const { path } = await runtime();
  await mkdir(join(path, "sessions"), { recursive: true });
  const sample = row();
  await writeFile(
    join(path, "config.json"),
    JSON.stringify({
      ...defaultConfig(),
      repositories: ["/a", "/empty", "/b"].map((path) => ({
        ...sample.repository,
        path,
      })),
    }),
  );
  const fixtures = [
    ["old-a", "/a", "2026-09-10T09:00:00.000Z"],
    ["new-b", "/b", "2026-09-12T09:00:00.000Z"],
    ["middle-a", "/a", "2026-09-11T09:00:00.000Z"],
    ["newest-orphan", "/removed", "2026-09-12T10:00:00.000Z"],
  ];
  for (const [id, repositoryPath, startedAt] of fixtures) {
    await writeFile(
      join(path, "sessions", `${id}.json`),
      JSON.stringify({
        ...sample.session,
        id,
        repositoryPath,
        startedAt,
      }),
    );
  }
  const rows = await loadDashboard();
  expect(rows.map((r) => r.session?.id)).toEqual([
    "newest-orphan",
    "new-b",
    "middle-a",
    "old-a",
    undefined,
  ]);
  expect(
    rows.filter((r) => r.repository?.path === "/a").map((r) => r.session?.id),
  ).toEqual(["middle-a", "old-a"]);
  expect(rows.at(-1)?.repository?.path).toBe("/empty");
});
it("reports corrupt state instead of initializing over it", async () => {
  const { path } = await runtime();
  await mkdir(path);
  await writeFile(join(path, "config.json"), "not json");
  await expect(loadDashboard()).rejects.toThrow();
  expect(await readFile(join(path, "config.json"), "utf8")).toBe("not json");
});
it("gates actions by lifecycle state and source validation evidence", () => {
  const r = row();
  expect(actionReason(r, "validate")).toBeUndefined();
  expect(actionReason(r, "integrate")).toContain("Validate");
  r.session!.sourceValidatedCommit = "source";
  expect(actionReason(r, "integrate")).toBeUndefined();
  for (const status of [
    "needs_review",
    "promotion_pending",
    "validation_pending",
  ] as const) {
    r.session!.status = status;
    expect(actionReason(r, "resume")).toBeUndefined();
    expect(actionReason(r, "integrate")).toContain("Resume");
    expect(actionReason(r, "validate")).toContain("active");
  }
  r.session!.waitingForLock = true;
  expect(actionReason(r, "resume")).toContain("waiting");
  r.session!.waitingForLock = false;
  r.session!.status = "succeeded";
  expect(actionReason(r, "resume")).toContain("already integrated");
});
it("preserves argument boundaries and requires the complete rollout contract", () => {
  const r = row();
  r.session!.sourceValidatedCommit = "source";
  const input = {
    summary: 'Literal "summary" $(touch /tmp/no)',
    rollout: "manual" as const,
    followUps: [
      "Configure FIXTURE_KEY in fixture project",
      "Then run fixture job",
    ],
  };
  expect(actionArguments(r, "integrate", input)).toEqual([
    "integrate",
    "--session",
    "session_example",
    "--summary",
    input.summary,
    "--rollout",
    "manual",
    "--follow-up",
    input.followUps[0],
    "--follow-up",
    input.followUps[1],
  ]);
  expect(() =>
    actionArguments(r, "integrate", { ...input, followUps: [] }),
  ).toThrow("at least one");
  expect(() =>
    actionArguments(r, "integrate", { ...input, rollout: "none" }),
  ).toThrow("manual rollout");
  expect(actionArguments(r, "validate")).toEqual([
    "validate",
    "--session",
    "session_example",
  ]);
});
it("keeps long follow-ups accessible and neutralizes terminal escape sequences", () => {
  const r = row();
  const followUp =
    "Configure FIXTURE_KEY in trusted fixture environment. ".repeat(10);
  r.session!.rolloutFollowUps = [followUp];
  r.session!.taskSummary = "unsafe\x1b[2J\x1b]52;c;clipboard\x07\rtext";
  const lines = wrapLines(detailLines(r), 35);
  expect(lines.every((line) => line.length <= 35)).toBe(true);
  expect(lines.join("")).toContain(followUp);
  expect(terminalText(r.session!.taskSummary)).not.toMatch(/[\x00-\x1f\x7f]/);
  expect(
    renderDashboard(
      Array.from({ length: 40 }, () => r),
      39,
      40,
      12,
    ).join("\n"),
  ).toContain("40/40");
});
it("rejects redirected dashboard use with a plain-output alternative", async () => {
  const { root, path } = await runtime();
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist/cli.js"), "dashboard"],
    {
      env: { ...process.env, PARALLEL_INTEGRATOR_HOME: path },
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("parallel-integrator status");
  expect(await readdir(root)).toEqual([]);
});
