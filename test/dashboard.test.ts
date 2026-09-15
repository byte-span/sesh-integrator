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
  defaultDashboardView,
  filterDashboard,
  dashboardSelection,
  navigateDashboard,
  type DashboardNavigation,
  colorDashboardLine,
  dashboardActivity,
  orderDashboard,
  actionArguments,
  actionReason,
  detailLines,
  loadDashboard,
  renderDashboard,
  renderDetailPane,
  scrollDetailPane,
  renderDashboardPicker,
  terminalText,
  wrapLines,
  type DashboardRow,
} from "../src/dashboard.js";
import { editTasks } from "../src/tasks.js";
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
  expect(result.stderr).toContain("seshx status");
  expect(await readdir(root)).toEqual([]);
});

it("prioritizes blockers without losing sessions and shows recorded milestones", () => {
  const active = row();
  const conflict = row();
  conflict.session = {
    ...conflict.session!,
    id: "conflict",
    status: "needs_review",
    awaitingConflictResolution: true,
  };
  const done = row();
  done.session = {
    ...done.session!,
    id: "done",
    status: "succeeded",
    promotedAt: "2026-09-12T11:00:00Z",
    integratedAt: "2026-09-12T10:59:00Z",
  };
  const ready = row();
  ready.session = { ...ready.session!, id: "ready", status: "ready" };
  const rows = orderDashboard([active, done, conflict, ready]);
  expect(rows.map((r) => r.session!.id)).toEqual([
    "conflict",
    "session_example",
    "done",
    "ready",
  ]);
  const output = renderDashboard(
    rows,
    0,
    160,
    40,
    new Date("2026-09-12T12:00:00Z"),
  ).join("\n");
  for (const label of [
    "3 active",
    "1 attention",
    "[active]",
    "repo",
    "Session",
    "Next action",
    "Recent activity",
    "Selected item",
    "merge conflict",
    "R resume",
  ])
    expect(output).toContain(label);
  expect(dashboardActivity(rows).map((e) => e.at)).toEqual([
    "2026-09-12T11:00:00Z",
    "2026-09-12T10:59:00Z",
  ]);
});
it("fits empty, crowded and narrow terminals with the selected session reachable", () => {
  const rows = Array.from({ length: 50 }, (_, i) => {
    const r = row();
    r.session = {
      ...r.session!,
      id: `session-${i}`,
      taskSummary: `task-${i}`,
      repositoryPath: `/repo-${i}`,
    };
    r.repository = { ...r.repository!, path: `/repo-${i}` };
    return r;
  });
  for (const [width, height] of [
    [35, 10],
    [79, 24],
    [100, 28],
    [160, 40],
  ]) {
    for (const data of [[], rows]) {
      const lines = renderDashboard(data, data.length - 1, width!, height!);
      expect(lines.length).toBeLessThanOrEqual(height!);
      expect(lines.every((l) => l.length <= width!)).toBe(true);
      expect(lines.join("\n")).not.toContain("undefined");
      if (data.length) {
        expect(lines.join("\n")).toContain("50/50");
        expect(lines.join("\n")).toContain("repo-49");
      }
    }
  }
});
it("only emits its own terminal color sequences", () => {
  const unsafe = "> task\x1b[2J\x1b]52;c;clipboard\x07";
  const colored = colorDashboardLine(unsafe);
  expect(colored).toContain("\x1b[44;97m");
  expect(colored).not.toContain("\x1b[2J");
  expect(colored).not.toContain("52;c;");
});

it("keeps details tied to the selected session", () => {
  const rows = Array.from({ length: 8 }, (_, i) => {
    const r = row();
    r.session = {
      ...r.session!,
      id: `session-${i}`,
      taskSummary: `unique-task-${i}`,
      status: i < 6 ? "needs_review" : "active",
    };
    return r;
  });
  let nav: DashboardNavigation = { sessions: 0 };
  nav = navigateDashboard(rows, nav, "down");
  expect(dashboardSelection(rows, nav)).toBe(1);
  const draw = (state: DashboardNavigation) =>
    renderDashboard(
      rows,
      dashboardSelection(rows, state),
      140,
      36,
      new Date(),
      state,
    );
  const before = draw(nav);
  nav = navigateDashboard(rows, nav, "down");
  const after = draw(nav);
  expect(before.join("\n")).toContain("unique-task-1");
  expect(after.join("\n")).toContain("unique-task-2");
  expect(after.filter((l) => /^(?:\| )?> /.test(l))).toHaveLength(1);
  expect(after.join("\n")).toContain("[active]");
});
it("clamps navigation at list boundaries", () => {
  const nav: DashboardNavigation = { sessions: 0 };
  expect(navigateDashboard([], nav, "down")).toEqual(nav);
  expect(navigateDashboard([row()], nav, "up")).toEqual(nav);
  expect(navigateDashboard([row()], nav, "down")).toEqual(nav);
});

it("filters across task, branch and repository and sorts by saved event time", () => {
  const active = row();
  const blocked = row();
  blocked.session = {
    ...blocked.session!,
    id: "blocked",
    status: "validation_pending",
    startedAt: "2026-09-10",
  };
  const done = row();
  done.session = {
    ...done.session!,
    id: "done",
    status: "succeeded",
    promotedAt: "2026-09-13",
    pullRequestUrl: "https://example.test/pr/1",
  };
  const rows = [active, blocked, done];
  const ids = (view: Partial<typeof defaultDashboardView>) =>
    filterDashboard(rows, {
      ...defaultDashboardView,
      filter: "all",
      ...view,
    }).map((r) => r.session!.id);
  expect(ids({})).toEqual(["done", "session_example", "blocked"]);
  expect(ids({ sort: "priority" })).toEqual([
    "blocked",
    "done",
    "session_example",
  ]);
  expect(ids({ sort: "updated" })).toEqual([
    "done",
    "session_example",
    "blocked",
  ]);
  expect(ids({ filter: "active" })).toEqual(["session_example", "blocked"]);
  expect(ids({ filter: "needs attention" })).toEqual(["blocked"]);
  expect(ids({ filter: "review" })).toEqual(["done"]);
  expect(ids({ filter: "completed" })).toEqual(["done"]);
  expect(ids({ query: "IMPLEMENT" })).toHaveLength(3);
  expect(ids({ query: "task", repository: "/repo" })).toHaveLength(3);
  expect(ids({ repository: "/missing" })).toEqual([]);
  expect(rows[0]).toBe(active);
});
it("keeps selection and next action visible at compact and split sizes", () => {
  const r = row();
  r.session!.status = "validation_pending";
  for (const [width, height] of [
    [35, 10],
    [80, 24],
    [110, 20],
    [160, 40],
  ]) {
    const output = renderDashboard([r], 0, width!, height!);
    expect(output.join("\n")).toContain("1/1");
    expect(output.some((line) => /^(?:\| )?> /.test(line))).toBe(true);
    expect(output.join("\n")).toContain(
      width! >= 110 ? "Next action" : "Next:",
    );
    expect(output).toHaveLength(height!);
  }
  expect(renderDashboard([], 0, 160, 30).join("\n")).toContain("No matches");
});
it("paints the selected table row without highlighting the detail pane", () => {
  const line = renderDashboard([row()], 0, 160, 30).find((l) =>
    /^(?:\| )?> /.test(l),
  )!;
  const painted = colorDashboardLine(line, true, true);
  expect(painted).toContain("│");
  expect(painted).toContain("48;2;48;86;109");
  expect(painted.split("│")[2]).not.toContain("48;2;48;86;109");
  expect(terminalText(painted)).toBe(line.replaceAll("|", "?"));
});

it("separates the header, table, detail sections and footer without overflow", () => {
  const lines = renderDashboard([row()], 0, 160, 40);
  expect(lines).toHaveLength(40);
  expect(lines.every((line) => line.length === 160)).toBe(true);
  expect(lines[0]).toMatch(/^\/-+\\$/);
  expect(lines[3]).toMatch(/^\\-+\/$/);
  expect(lines[4]!.trim()).toBe("");
  expect(lines[8]).toMatch(/^\| -+ \| /);
  for (const title of ["Next action", "Recent activity"]) {
    const index = lines.findIndex((line) => line.includes(title));
    expect(lines[index - 1]).toMatch(
      title === "Next action" ? /\| +\|$/ : /\| -+ \|$/,
    );
  }
  expect(lines.at(-4)).toMatch(/^\+-+\+$/);
  expect(colorDashboardLine(lines[0]!, true, true)).toContain("┌");
  expect(colorDashboardLine(lines.at(-1)!, true, true)).toContain("┘");
});

it("keeps scrolling pickers inside compact and framed dashboards", () => {
  for (const [width, height] of [
    [35, 10],
    [79, 24],
    [159, 40],
  ]) {
    const background = renderDashboard([], 0, width!, height!);
    const lines = renderDashboardPicker(
      background,
      {
        kind: "repository",
        options: Array.from({ length: 50 }, (_, i) => ({
          value: String(i),
          label: `repo-${i}`,
        })),
        selected: 49,
      },
      width!,
    );
    expect(lines).toHaveLength(background.length);
    expect(lines.every((line) => line.length <= width!)).toBe(true);
    expect(lines.join("\n")).toContain("> repo-49");
    expect(lines.join("\n")).toContain("Esc cancel");
  }
});

it("shows the current task and progress, searches checklist text, and flags task blockers", () => {
  const r = row();
  r.session!.tasks = editTasks([], {
    action: "add",
    titles: ["Inspect", "Build CLI", "Validate"],
  });
  r.session!.tasks = editTasks(r.session!.tasks, {
    action: "update",
    id: 1,
    status: "completed",
  });
  r.session!.tasks = editTasks(r.session!.tasks, {
    action: "update",
    id: 2,
    status: "in_progress",
    description: "Handle persistent task metadata",
  });
  const output = renderDashboard([r], 0, 180, 40).join("\n");
  expect(output).toContain("Build CLI");
  expect(output).toContain("1/3");
  expect(output).not.toContain("1/3 completed");
  const checklist = renderDetailPane(
    r,
    60,
    25,
    Number.MAX_SAFE_INTEGER,
  ).lines.join("\n");
  expect(checklist).toContain("1/3 completed");
  expect(checklist).toContain("[x] Inspect");
  expect(checklist).toContain("[>] Build CLI");
  expect(
    filterDashboard([r], {
      ...defaultDashboardView,
      query: "persistent task metadata",
    }),
  ).toEqual([r]);
  r.session!.tasks = editTasks(r.session!.tasks, {
    action: "update",
    id: 2,
    status: "blocked",
    reason: "Need a fixture",
  });
  expect(
    filterDashboard([r], {
      ...defaultDashboardView,
      filter: "needs attention",
    }),
  ).toEqual([r]);
});

it("wraps every task and follow-up within an independently scrollable pane with pinned title and status", () => {
  const r = row();
  r.session!.tasks = editTasks([], {
    action: "add",
    titles: Array.from(
      { length: 9 },
      (_, i) => `Task ${i + 1}: ` + "long content ".repeat(12),
    ),
  });
  r.session!.tasks = editTasks(r.session!.tasks, {
    action: "update",
    id: 1,
    status: "completed",
  });
  r.session!.tasks = editTasks(r.session!.tasks, {
    action: "update",
    id: 2,
    status: "in_progress",
  });
  r.session!.tasks = editTasks(r.session!.tasks, {
    action: "update",
    id: 9,
    status: "skipped",
    reason: "Replaced by end-to-end coverage",
  });
  r.session!.rolloutFollowUps = [
    "Configure the fixture on a trusted machine. ".repeat(10),
  ];
  for (const [width, height] of [
    [32, 14],
    [79, 22],
    [35, 7],
  ]) {
    let pane = renderDetailPane(r, width!, height!);
    const pinned = pane.lines.slice(0, 2);
    let content = "";
    for (let offset = 0; offset <= pane.maxOffset; offset++) {
      pane = renderDetailPane(r, width!, height!, offset);
      expect(pane.lines.length).toBe(height);
      expect(pane.lines.every((line) => line.length <= width!)).toBe(true);
      expect(pane.lines.slice(0, pinned.length)).toEqual(pinned);
      content += pane.lines.join("");
    }
    expect(content).toContain("Task 9:");
    expect(content).toContain("trusted machine");
    expect(pane.lines.at(-1)).not.toContain("More below");
    expect(pane.lines.at(-1)).toBe("End of details - more above");
    expect(renderDetailPane(r, width!, height!, 99999).offset).toBe(
      pane.maxOffset,
    );
    expect(scrollDetailPane(0, "pageup", pane.pageSize, pane.maxOffset)).toBe(
      0,
    );
    expect(scrollDetailPane(0, "pagedown", pane.pageSize, pane.maxOffset)).toBe(
      pane.pageSize,
    );
    expect(scrollDetailPane(0, "end", pane.pageSize, pane.maxOffset)).toBe(
      pane.maxOffset,
    );
    expect(
      scrollDetailPane(pane.maxOffset, "home", pane.pageSize, pane.maxOffset),
    ).toBe(0);
  }
});

it("defaults to unfinished sessions and separates session purpose, current task and progress", () => {
  const active = row();
  active.session!.taskSummary = "Add login flow";
  active.session!.tasks = editTasks([], {
    action: "add",
    titles: ["Design form", "Test reset"],
  });
  active.session!.tasks = editTasks(active.session!.tasks, {
    action: "update",
    id: 1,
    status: "completed",
  });
  active.session!.tasks = editTasks(active.session!.tasks, {
    action: "update",
    id: 2,
    status: "in_progress",
  });
  const completed = row();
  completed.session = {
    ...active.session!,
    id: "finished",
    status: "succeeded",
  };
  const blocked = row();
  blocked.session = {
    ...active.session!,
    id: "blocked",
    status: "promotion_pending",
  };
  expect(defaultDashboardView.filter).toBe("active");
  expect(
    filterDashboard([active, completed, blocked], defaultDashboardView).map(
      (r) => r.session!.id,
    ),
  ).toEqual(["session_example", "blocked"]);
  expect(
    filterDashboard([active, completed], {
      ...defaultDashboardView,
      filter: "completed",
    }),
  ).toEqual([completed]);
  const output = renderDashboard([active, completed], 0, 180, 36).join("\n");
  for (const heading of ["Repository", "Session", "Status"])
    expect(output).toContain(heading);
  expect(output).toContain("Add login flow");
  expect(output).toContain("Test reset");
  expect(output).toContain("1/2");
  expect(output).toContain("Integrated");
  expect(output).not.toContain("task / done");
  const compact = renderDashboard([active], 0, 79, 24).join("\n");
  expect(compact).toContain("Add login flow");
  expect(compact).toContain("Task: Test reset");
  expect(compact).toContain("In progress | 1/2");
  for (const width of [50, 79, 180]) {
    for (const status of ["succeeded", "no_changes"] as const) {
      completed.session!.status = status;
      const lines = renderDashboard([completed], 0, width, 36);
      const list = lines.map((line) =>
        width >= 110 ? line.split(" | ")[0] : line,
      );
      expect(list.join("\n")).toContain(
        status === "succeeded" ? "Integrated" : "No changes",
      );
      expect(list.join("\n")).not.toContain("Task: Test reset");
      expect(list.join("\n")).not.toContain("1/2");
    }
  }
});

it("shows skipped progress explicitly and moves verified no-change sessions out of Active", () => {
  const r = row();
  r.session!.tasks = editTasks([], {
    action: "add",
    titles: ["Implement", "Integrate"],
  });
  for (const id of [1, 2])
    r.session!.tasks = editTasks(r.session!.tasks, {
      action: "update",
      id,
      status: "skipped",
      reason: "Already fixed",
    });
  let screen = renderDashboard([r], 0, 180, 36).join("\n");
  expect(screen).toContain("2 skipped");
  const tableRow = screen.split("\n").find((line) => line.startsWith("| >"))!;
  expect(tableRow).toContain("2 skipped");
  expect(tableRow).not.toContain("0/2");
  r.session!.status = "no_changes";
  r.session!.closedAt = "2026-09-15T05:00:00Z";
  expect(filterDashboard([r], defaultDashboardView)).toEqual([]);
  expect(
    filterDashboard([r], { ...defaultDashboardView, filter: "completed" }),
  ).toEqual([r]);
  expect(actionReason(r, "integrate")).toContain("finished without changes");
  screen = renderDashboard([r], 0, 180, 36).join("\n");
  expect(screen).toContain("No changes");
  expect(screen).not.toContain("2 skipped");
  const checklist = renderDetailPane(
    r,
    60,
    25,
    Number.MAX_SAFE_INTEGER,
  ).lines.join("\n");
  expect(checklist).toContain("2 skipped");
});

it("puts the checklist last and keeps a readable title and status above the next action", () => {
  const r = row();
  r.session!.taskSummary =
    "Align README sign-in instructions with hosted authentication";
  r.session!.status = "no_changes";
  r.session!.tasks = editTasks([], {
    action: "add",
    titles: ["Review documentation"],
  });
  r.session!.tasks = editTasks(r.session!.tasks, {
    action: "update",
    id: 1,
    status: "skipped",
    reason: "Already implemented",
  });
  const pane = renderDetailPane(r, 40, 100);
  const text = pane.lines.join("\n");
  expect(pane.lines.slice(0, 3)).toEqual([
    "Align README sign-in instructions with",
    "hosted authentication",
    "No changes",
  ]);
  expect(text.indexOf("Next action")).toBeLessThan(
    text.indexOf("Recent activity"),
  );
  expect(text.indexOf("Source branch:")).toBeLessThan(text.indexOf("Tasks\n"));
  expect(text.indexOf("Tasks\n")).toBeLessThan(
    text.indexOf("1. [-] Review documentation"),
  );
  expect(text).not.toContain("Current:");
});

it("separates and labels scroll position and remaining content", () => {
  const r = row();
  const top = renderDetailPane(r, 40, 14);
  expect(top.lines.at(-3)).toBe("-".repeat(40));
  expect(top.lines.at(-2)).toMatch(/^Lines 1-\d+ of \d+$/);
  expect(top.lines.at(-1)).toBe("More below");
  const middle = renderDetailPane(r, 40, 14, 2);
  expect(middle.lines.at(-1)).toBe("More above and below");
  const bottom = renderDetailPane(r, 40, 14, Number.MAX_SAFE_INTEGER);
  expect(bottom.lines.at(-1)).toBe("End of details - more above");
  expect(renderDetailPane(r, 100, 100).lines.at(-1)).toBe("All content shown");
  for (const height of [4, 5, 6, 7]) {
    const small = renderDetailPane(r, 20, height);
    expect(small.lines).toHaveLength(height);
    expect(small.lines.every((line) => line.length <= 20)).toBe(true);
  }
});
