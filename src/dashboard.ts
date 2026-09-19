import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { watchDashboard } from "./dashboard-watch.js";
import { currentTask, taskProgress, taskLines } from "./tasks.js";
import { targetBranch } from "./promotion.js";
import { pullRequestPromotion } from "./pull-request.js";
import { readConfig, readSessions } from "./runtime.js";
import type { RepositoryConfig, RolloutDisposition, Session } from "./types.js";

export type DashboardAction = "validate" | "integrate" | "resume";
export interface DashboardRow {
  repository: RepositoryConfig | undefined;
  session: Session | undefined;
}
export interface IntegrationInput {
  summary: string;
  rollout: RolloutDisposition;
  followUps: string[];
}

// Never let saved task text act as terminal control sequences. ASCII also keeps
// clipping predictable on terminals with different Unicode cell-width tables.
export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[^\x20-\x7e]/g, "?");
}

export async function loadDashboard(): Promise<DashboardRow[]> {
  const [config, sessions] = await Promise.all([
    readConfig(true),
    readSessions(true),
  ]);
  const repositories = new Map(config.repositories.map((r) => [r.path, r]));
  // readSessions returns chronological order. Reverse before associating each
  // session with its repository so directory grouping never affects recency.
  const rows: DashboardRow[] = sessions.reverse().map((session) => ({
    repository: repositories.get(session.repositoryPath),
    session,
  }));
  const occupied = new Set(sessions.map((session) => session.repositoryPath));
  for (const repository of config.repositories) {
    if (!occupied.has(repository.path))
      rows.push({ repository, session: undefined });
  }
  return rows;
}

export function actionReason(
  row: DashboardRow,
  action: DashboardAction,
): string | undefined {
  const s = row.session;
  if (!s) return "No session selected";
  if (!row.repository) return "Repository is no longer registered";
  if (s.waitingForLock)
    return "Session is already waiting for the repository lock";
  if (s.status === "no_changes") return "Session finished without changes";
  if (s.status === "succeeded") return "Session already integrated";
  if (action === "validate")
    return s.status === "active"
      ? undefined
      : "Validation requires an active source session";
  if (action === "resume")
    return [
      "needs_review",
      "validation_pending",
      "promotion_pending",
      "ready",
    ].includes(s.status)
      ? undefined
      : "No recorded integration to resume";
  if (!["active", "ready"].includes(s.status))
    return "Use Resume for the preserved integration";
  if (s.validationFailure?.phase === "source")
    return "Source validation failed; validate again";
  if (!s.sourceValidatedCommit) return "Validate the committed source first";
  return undefined;
}

export function actionArguments(
  row: DashboardRow,
  action: DashboardAction,
  input?: IntegrationInput,
): string[] {
  const reason = actionReason(row, action);
  if (reason) throw new Error(reason);
  const args = [action, "--session", row.session!.id];
  if (action === "integrate") {
    if (!input?.summary.trim()) throw new Error("Enter a completion summary");
    if (!["none", "applied", "automated", "manual"].includes(input.rollout))
      throw new Error("Choose none, applied, automated, or manual");
    if (
      input.rollout === "manual" &&
      !input.followUps.some((value) => value.trim())
    )
      throw new Error("Manual rollout requires at least one follow-up");
    if (input.followUps.some((value) => !value.trim()))
      throw new Error("Follow-ups must not be empty");
    if (input.rollout !== "manual" && input.followUps.length)
      throw new Error("Follow-ups require manual rollout");
    args.push("--summary", input.summary.trim(), "--rollout", input.rollout);
    for (const followUp of input.followUps) args.push("--follow-up", followUp);
  }
  return args;
}

export function exactTime(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "unknown"
    : `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function detailLines(row: DashboardRow, includeTasks = true): string[] {
  const { session: s, repository: r } = row;
  const lines = [
    `Repository: ${r?.path ?? s?.repositoryPath ?? "-"}`,
    `Target: ${r ? targetBranch(r) : (s?.targetBranch ?? "unregistered")}`,
  ];
  if (!s)
    return [...lines, "No sessions. Run seshx begin from this repository."];
  lines.push(
    `Session: ${s.id}`,
    `Task: ${s.taskSummary}`,
    `Started: ${exactTime(s.startedAt)}`,
    `Status: ${s.status}${s.waitingForLock ? " (waiting for lock)" : ""}`,
    `Source branch: ${s.branch}`,
    `Source worktree: ${s.worktreePath}`,
    `Source validation: ${s.sourceValidatedCommit ? `${s.sourceValidatedCommit} at ${s.sourceValidatedAt ?? "unknown time"}` : "not recorded"}`,
    "Validation is recorded for that commit; commands recheck current Git state.",
    `Validation tier: ${s.validationTier ?? "not recorded"}`,
    `Ready commit: ${s.readyCommit ?? "not recorded"}`,
    `Staging commit: ${s.integratedCommit ?? "not recorded"}`,
    `Target promotion: ${s.promotedCommit ?? "not promoted"}`,
    `Rollout: ${s.rolloutDisposition ?? "unclassified"}`,
  );
  if (includeTasks)
    lines.splice(
      2,
      0,
      `Tasks: ${taskProgress(s)}`,
      `Current task: ${currentTask(s)}`,
      ...taskLines(s),
      "",
    );
  if (s.closedAt)
    lines.push(`Finished without changes: ${exactTime(s.closedAt)}`);
  if (s.satisfiedBySessionId)
    lines.push(`Satisfied by session: ${s.satisfiedBySessionId}`);
  if (s.completionSummary) lines.push(`Completion: ${s.completionSummary}`);
  if (s.rolloutDisposition === "automated")
    lines.push("External automation delegated; completion not verified.");
  if (s.pullRequestUrl) lines.push(`Review and merge: ${s.pullRequestUrl}`);
  for (const followUp of s.rolloutFollowUps ?? [])
    lines.push(`Follow-up: ${followUp}`);
  if (s.validationFailure)
    lines.push(
      `Validation failure: ${s.validationFailure.phase}: ${s.validationFailure.message}`,
    );
  if (s.recoveryPhase) lines.push(`Recovery phase: ${s.recoveryPhase}`);
  if (s.integrationWorktreePath)
    lines.push(`Integration worktree: ${s.integrationWorktreePath}`);
  if (s.awaitingConflictResolution)
    lines.push(
      "Resolve and stage conflicts in the integration worktree before Resume.",
    );
  if (s.conflictPromptPath)
    lines.push(`Conflict instructions: ${s.conflictPromptPath}`);
  if (s.latestIncidentId) lines.push(`Incident: ${s.latestIncidentId}`);
  if (s.latestError) lines.push(`Last error: ${s.latestError}`);
  if (r) {
    const remote = pullRequestPromotion(r);
    if (remote)
      lines.push(
        `Configured PR promotion: ${remote.remote} -> ${remote.productionBranch} (${remote.mode})`,
      );
  }
  return lines;
}

const detailLabelPattern = /^([A-Z][A-Za-z -]{1,30}:)(?: |$)/;

/** Keep field values together and align wrapped continuations. */
export function detailFieldLines(row: DashboardRow, width: number): string[] {
  width = Math.max(1, Math.floor(width));
  const fields = detailLines(row, false).map(terminalText);
  const labelWidth = Math.max(
    ...fields.map((line) => line.match(detailLabelPattern)?.[1]?.length ?? 0),
  );
  const tabular = width >= 72;
  const indent = tabular ? labelWidth + 2 : Math.min(2, width - 1);
  return fields.flatMap((line, index) => {
    const match = line.match(detailLabelPattern);
    const label = match?.[1];
    const value = label ? line.slice(match![0].length) : line;
    const values = wrapWords(value, width - indent);
    const content = tabular
      ? values.map(
          (part, i) =>
            `${(i === 0 ? (label ?? "") : "").padEnd(indent)}${part}`,
        )
      : [
          ...(label ? wrapLines([label], width) : []),
          ...values.map((part) => `${" ".repeat(indent)}${part}`),
        ];
    return [...(index && label ? [""] : []), ...content];
  });
}

/** Keep status and order compact while giving task text the remaining width. */
export function taskTableLines(session: Session, width: number): string[] {
  width = Math.max(1, Math.floor(width));
  const tasks = session.tasks ?? [];
  if (!tasks.length) return [];
  const labels = {
    pending: "Pending",
    in_progress: "In progress",
    completed: "Completed",
    blocked: "Blocked",
    skipped: "Skipped",
  };
  const statusWidth = Math.max(
    6,
    ...tasks.map((task) => labels[task.status].length),
  );
  const numberWidth = String(tasks.length).length;
  const prefixWidth = statusWidth + numberWidth + 6;
  const tabular = width - prefixWidth >= 10;
  const taskWidth = tabular ? width - prefixWidth : width;
  const row = (status: string, number: string, text: string) =>
    `${status.padEnd(statusWidth)} | ${number.padStart(numberWidth)} | ${text}`;
  const lines = tabular ? [row("Status", "#", "Task"), "-".repeat(width)] : [];
  tasks.forEach((task, index) => {
    if (index) lines.push("");
    const title = wrapWords(terminalText(task.title), taskWidth);
    if (tabular) {
      lines.push(
        ...title.map((part, line) =>
          row(
            line === 0 ? labels[task.status] : "",
            line === 0 ? String(index + 1) : "",
            part,
          ),
        ),
      );
    } else {
      lines.push(
        ...wrapWords(`${labels[task.status]} | ${index + 1}`, width),
        ...title,
      );
    }
    for (const detail of [
      task.description,
      task.reason ? `Reason: ${task.reason}` : undefined,
    ]) {
      if (!detail) continue;
      const indent = Math.min(tabular ? 2 : 4, taskWidth - 1);
      const wrapped = wrapWords(terminalText(detail), taskWidth - indent);
      lines.push(
        ...wrapped.map((part) =>
          tabular
            ? row("", "", `${" ".repeat(indent)}${part}`)
            : `${" ".repeat(indent)}${part}`,
        ),
      );
    }
  });
  return lines;
}

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  while (text.length > width) {
    const space = text.lastIndexOf(" ", width);
    const end = space > 0 ? space : width;
    lines.push(text.slice(0, end));
    text = text.slice(end).trimStart();
  }
  lines.push(text);
  return lines;
}

export function wrapLines(lines: string[], width: number): string[] {
  width = Math.max(1, width);
  return lines.flatMap((line) => {
    const text = terminalText(line);
    const wrapped: string[] = [];
    for (let offset = 0; offset < text.length; offset += width)
      wrapped.push(text.slice(offset, offset + width));
    return wrapped.length ? wrapped : [""];
  });
}

export interface DetailPaneState {
  focused: boolean;
  offset: number;
}

function sessionCurrentTask(session?: Session): string {
  if (!session || ["succeeded", "no_changes"].includes(session.status))
    return "";
  return session.tasks?.some((task) =>
    ["pending", "in_progress", "blocked"].includes(task.status),
  )
    ? currentTask(session)
    : "";
}

function sessionStatusLabel(row: DashboardRow): string {
  const session = row.session;
  if (!row.repository || !session) return stateLabel(row);
  if (session.status === "no_changes") return "No changes";
  if (session.status === "succeeded") return "Integrated";
  return session.status === "active" ? "In progress" : stateLabel(row);
}

function sessionRowStatus(row: DashboardRow): string {
  const status = sessionStatusLabel(row);
  const session = row.session;
  return row.repository &&
    session?.tasks?.length &&
    !["succeeded", "no_changes"].includes(session.status)
    ? `${status} | ${sessionProgress(session)}`
    : status;
}

function sessionRowHeight(row: DashboardRow, tabular: boolean): number {
  return (tabular ? 1 : 2) + (sessionCurrentTask(row.session) ? 1 : 0);
}

function sessionProgress(session?: Session): string {
  if (!session?.tasks?.length) return "-";
  const completed = session.tasks.filter(
    (task) => task.status === "completed",
  ).length;
  const skipped = session.tasks.filter(
    (task) => task.status === "skipped",
  ).length;
  if (skipped === session.tasks.length) return `${skipped} skipped`;
  return `${completed}/${session.tasks.length}${skipped ? `, ${skipped} skipped` : ""}`;
}

/** The title and status stay pinned; tasks follow the session details. */
export function renderDetailPane(
  row: DashboardRow,
  width: number,
  height: number,
  requestedOffset = 0,
) {
  width = Math.max(1, width);
  height = Math.max(4, height);
  const s = row.session;
  const heading = terminalText(s?.taskSummary ?? "No session");
  const titleLines = wrapWords(heading, width);
  const titleLimit = Math.min(3, Math.max(1, height - 6));
  const title = titleLines.slice(0, titleLimit);
  if (titleLines.length > titleLimit)
    title[titleLimit - 1] =
      title[titleLimit - 1]!.slice(0, Math.max(0, width - 3)) +
      "...".slice(0, width);
  const header = [
    ...title,
    terminalText(sessionStatusLabel(row)).slice(0, width),
  ];
  const body = wrapLines(
    [
      "",
      "Next action",
      nextStep(row),
      "-".repeat(width),
      "Recent activity",
      ...dashboardActivity([row])
        .slice(0, 3)
        .map(
          (e) =>
            `${e.at.slice(0, 10)} ${e.at.slice(11, 19)}  ${e.text.split(" | ")[0]}`,
        ),
      ...(!dashboardActivity([row]).length ? ["No saved milestones yet."] : []),
      "-".repeat(width),
      ...detailFieldLines(row, width),
      ...(s?.tasks?.length
        ? [
            "-".repeat(width),
            "Tasks",
            taskProgress(s),
            ...taskTableLines(s, width),
          ]
        : []),
    ],
    width,
  );
  const footerHeight = Math.min(3, height - 3);
  const pageSize = Math.max(1, height - header.length - footerHeight);
  const maxOffset = Math.max(0, body.length - pageSize);
  const offset = Math.max(0, Math.min(requestedOffset, maxOffset));
  const shown = body.slice(offset, offset + pageSize);
  while (shown.length < pageSize) shown.push("");
  const end = Math.min(body.length, offset + pageSize);
  const position = `Lines ${offset + 1}-${end} of ${body.length}`;
  const remainingContent =
    offset > 0
      ? end < body.length
        ? "More above and below"
        : "End of details - more above"
      : end < body.length
        ? "More below"
        : "All content shown";
  const footer =
    footerHeight === 3
      ? ["-".repeat(width), position, remainingContent]
      : footerHeight === 2
        ? ["-".repeat(width), position]
        : [position];
  return {
    offset,
    maxOffset,
    pageSize,
    lines: [...header, ...shown, ...footer.map((line) => line.slice(0, width))],
  };
}

export function scrollDetailPane(
  offset: number,
  key: string,
  pageSize: number,
  maxOffset: number,
): number {
  return Math.max(
    0,
    Math.min(
      maxOffset,
      key === "home"
        ? 0
        : key === "end"
          ? maxOffset
          : offset +
            (key === "pageup"
              ? -pageSize
              : key === "pagedown"
                ? pageSize
                : key === "up"
                  ? -1
                  : key === "down"
                    ? 1
                    : 0),
    ),
  );
}

export function needsAttention(row: DashboardRow): boolean {
  const s = row.session;
  return (
    !!s &&
    !["succeeded", "no_changes"].includes(s.status) &&
    (!row.repository ||
      !!s.validationFailure ||
      !!s.tasks?.some((task) => task.status === "blocked") ||
      !!s.latestError ||
      ["needs_review", "validation_pending", "promotion_pending"].includes(
        s.status,
      ))
  );
}

export function orderDashboard(rows: DashboardRow[]): DashboardRow[] {
  return [...rows].sort(
    (a, b) => Number(needsAttention(b)) - Number(needsAttention(a)),
  );
}

function stateLabel(row: DashboardRow): string {
  const s = row.session;
  if (!s) return "no sessions";
  if (!row.repository) return "unregistered";
  if (s.status === "no_changes") return "no changes needed";
  if (s.status === "succeeded") return "completed";
  if (s.waitingForLock) return "waiting for lock";
  if (s.awaitingConflictResolution) return "merge conflict";
  if (s.validationFailure) return "validation failed";
  return s.status.replaceAll("_", " ");
}

function nextStep(row: DashboardRow): string {
  const s = row.session;
  if (!s) return "Run begin in this repository";
  if (!row.repository) return "Restore repository registration";
  if (["succeeded", "no_changes"].includes(s.status)) {
    if (s.pullRequestUrl) return "Review and merge PR; Enter for follow-ups";
    if (s.rolloutFollowUps?.length)
      return "Complete external follow-ups; Enter details";
    return "Enter to inspect completion and rollout";
  }
  if (s.waitingForLock) return "Wait for the current command; r refresh";
  if (s.awaitingConflictResolution)
    return "Resolve and stage conflicts, then R resume";
  if (s.status === "promotion_pending")
    return "Inspect promotion blocker, then R resume";
  if (s.status === "validation_pending")
    return "Inspect failed check, then R resume when safe";
  if (s.status === "needs_review")
    return "Inspect recovery details before R resume";
  if (s.validationFailure) return "Inspect failed check, then v validate";
  if (s.latestError) return "Enter to inspect the last error";
  return s.sourceValidatedCommit
    ? "i integrate (CLI rechecks saved validation)"
    : "Commit source changes, then v validate";
}

export function dashboardActivity(
  rows: DashboardRow[],
): { at: string; text: string }[] {
  return rows
    .flatMap(({ session: s }) => {
      if (!s) return [];
      return (
        [
          [s.sourceValidatedAt, "validated"],
          [s.integratedAt, "integrated"],
          [s.promotedAt, "promoted"],
        ] as const
      ).flatMap(([at, action]) =>
        at && Number.isFinite(Date.parse(at))
          ? [
              {
                at,
                text: `${action} | ${basename(s.repositoryPath)} | ${s.taskSummary}`,
              },
            ]
          : [],
      );
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export interface DashboardNavigation {
  sessions: number;
}

export function dashboardSelection(
  rows: DashboardRow[],
  nav: DashboardNavigation,
): number {
  return nav.sessions;
}

export function navigateDashboard(
  rows: DashboardRow[],
  nav: DashboardNavigation,
  key: "up" | "down",
): DashboardNavigation {
  return {
    sessions: Math.max(
      0,
      Math.min(rows.length - 1, nav.sessions + (key === "down" ? 1 : -1)),
    ),
  };
}

export interface DashboardView {
  filter: "all" | "needs attention" | "active" | "review" | "completed";
  repository: string;
  query: string;
  sort: "priority" | "updated" | "repository";
}
export const defaultDashboardView: DashboardView = {
  filter: "all",
  repository: "",
  query: "",
  sort: "updated",
};

interface DashboardPicker {
  kind: "repository" | "sort";
  options: { value: string; label: string }[];
  selected: number;
}

function dashboardPickerLayout(
  lines: string[],
  picker: DashboardPicker,
  width: number,
) {
  const controlRow = lines[0]?.startsWith("/") ? 2 : 1;
  const controls = lines[controlRow] ?? "";
  const anchor = controls.indexOf(
    picker.kind === "repository" ? "repo:" : "sort:",
  );
  const compactAnchor = controls.indexOf(
    picker.kind === "repository" ? "p " : "s ",
  );
  const boxWidth = Math.min(
    width,
    Math.max(
      34,
      ...picker.options.map((o) => terminalText(o.label).length + 6),
    ),
  );
  const left = Math.max(
    0,
    Math.min(anchor >= 0 ? anchor : compactAnchor, width - boxWidth),
  );
  const top = controlRow + 1;
  const count = Math.max(
    1,
    Math.min(picker.options.length, lines.length - top - 6),
  );
  const start = Math.max(0, picker.selected - count + 1);
  const inside = (value: string) =>
    "| " +
    terminalText(value)
      .slice(0, boxWidth - 4)
      .padEnd(boxWidth - 4) +
    " |";
  const border = "+" + "-".repeat(boxWidth - 2) + "+";
  const box = [
    border,
    inside(
      `${picker.kind === "repository" ? "Repository" : "Sort"}  ${picker.selected + 1}/${picker.options.length}`,
    ),
    ...picker.options
      .slice(start, start + count)
      .map((o, i) =>
        inside(`${start + i === picker.selected ? ">" : " "} ${o.label}`),
      ),
    border,
    inside("Up/Down move  Enter apply"),
    inside("Esc cancel"),
    border,
  ];
  return { left, top, box };
}

export function renderDashboardPicker(
  lines: string[],
  picker: DashboardPicker,
  width: number,
): string[] {
  const result = [...lines];
  const { left, top, box } = dashboardPickerLayout(lines, picker, width);
  box.forEach((line, i) => {
    const background = (result[top + i] ?? "").padEnd(width);
    result[top + i] =
      background.slice(0, left) + line + background.slice(left + line.length);
  });
  return result;
}

function updatedAt(row: DashboardRow): number {
  const s = row.session;
  if (!s) return 0;
  return Math.max(
    0,
    ...[
      s.startedAt,
      s.tasksUpdatedAt,
      s.closedAt,
      s.readyAt,
      s.sourceValidatedAt,
      s.integratedAt,
      s.promotedAt,
      s.remotePromotedAt,
      s.validationFailure?.failedAt,
    ].map((value) => (value ? Date.parse(value) || 0 : 0)),
  );
}

export function filterDashboard(
  rows: DashboardRow[],
  view: DashboardView,
): DashboardRow[] {
  const result = rows.filter((row) => {
    const s = row.session;
    const path = row.repository?.path ?? s?.repositoryPath ?? "";
    const matches =
      view.filter === "all" ||
      (view.filter === "needs attention" && needsAttention(row)) ||
      (view.filter === "active" &&
        !!s &&
        !["succeeded", "no_changes"].includes(s.status)) ||
      (view.filter === "review" &&
        (s?.status === "needs_review" || !!s?.pullRequestUrl)) ||
      (view.filter === "completed" &&
        !!s &&
        ["succeeded", "no_changes"].includes(s.status));
    return (
      matches &&
      (!view.repository || path === view.repository) &&
      terminalText(
        [
          path,
          s?.taskSummary,
          s?.id,
          s?.branch,
          stateLabel(row),
          ...(s?.tasks ?? []).flatMap((task) => [
            task.title,
            task.description,
            task.reason,
          ]),
        ].join(" "),
      )
        .toLowerCase()
        .includes(view.query.toLowerCase())
    );
  });
  const name = (r: DashboardRow) =>
    r.repository?.path ?? r.session?.repositoryPath ?? "";
  return result.sort(
    (a, b) =>
      (view.sort === "priority"
        ? Number(needsAttention(b)) - Number(needsAttention(a))
        : view.sort === "repository"
          ? name(a).localeCompare(name(b))
          : 0) || updatedAt(b) - updatedAt(a),
  );
}

// Keep the compact layout usable; framing needs room for its seven extra rows.
export function renderDashboard(
  rows: DashboardRow[],
  selected: number,
  width: number,
  height: number,
  refreshedAt = new Date(),
  navigation: DashboardNavigation = {
    sessions: selected,
  },
  view: DashboardView = defaultDashboardView,
  now = new Date(),
  pane: DetailPaneState = { focused: false, offset: 0 },
): string[] {
  const framed = width >= 114 && height >= 27;
  if (!framed)
    return renderDashboardContent(
      rows,
      selected,
      width,
      height,
      refreshedAt,
      navigation,
      view,
      now,
      pane,
    );
  width = Math.floor(width);
  height = Math.floor(height);
  const innerWidth = width - 4;
  const content = renderDashboardContent(
    rows,
    selected,
    innerWidth,
    height - 7,
    refreshedAt,
    navigation,
    view,
    now,
    pane,
  );
  const border = "+" + "-".repeat(width - 2) + "+";
  const top = "/" + "-".repeat(width - 2) + "\\";
  const bottom = "\\" + "-".repeat(width - 2) + "/";
  const frame = (line: string) => "| " + line.padEnd(innerWidth) + " |";
  const leftWidth = Math.floor(innerWidth * 0.68);
  const tableRule =
    "-".repeat(leftWidth) + " | " + " ".repeat(innerWidth - leftWidth - 3);
  return [
    top,
    frame(content[0]!),
    frame(content[1]!),
    bottom,
    " ".repeat(width),
    top,
    frame(content[2]!),
    frame(content[3]!),
    frame(tableRule),
    ...content.slice(4, -2).map(frame),
    border,
    ...content.slice(-2).map(frame),
    bottom,
  ];
}

function renderDashboardContent(
  rows: DashboardRow[],
  selected: number,
  width: number,
  height: number,
  refreshedAt = new Date(),
  navigation: DashboardNavigation = {
    sessions: selected,
  },
  view: DashboardView = defaultDashboardView,
  now = new Date(),
  pane: DetailPaneState = { focused: false, offset: 0 },
): string[] {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const fit = (value: string, size: number) => {
    size = Math.max(0, size);
    const safe = terminalText(value);
    return (
      safe.length > size && size > 3
        ? safe.slice(0, size - 3) + "..."
        : safe.slice(0, size)
    ).padEnd(size);
  };
  const name = (r: DashboardRow) =>
    basename(r.repository?.path ?? r.session?.repositoryPath ?? "-");
  const visible = rows;
  const cursor = navigation.sessions;
  const selectedRow = rows[selected];
  const attention = rows.filter(needsAttention).length;
  const active = rows.filter(
    (r) => r.session && !["succeeded", "no_changes"].includes(r.session.status),
  ).length;
  const title = `sesh-integrator  ${visible.length} visible | ${attention} attention | ${active} active`;
  const refresh = `Last refresh ${exactTime(refreshedAt.getTime())}`;
  const wide = width >= 110 && height >= 20;
  const leftWidth = wide ? Math.floor(width * 0.68) : width;
  const rightWidth = wide ? width - leftWidth - 3 : width;
  const tabular = leftWidth >= 70;
  const repoWidth = Math.min(18, Math.max(10, Math.floor(leftWidth * 0.18)));
  const statusWidth = Math.min(
    Math.floor(leftWidth * 0.36),
    Math.max(18, ...rows.map((row) => sessionRowStatus(row).length)),
  );
  const descriptionWidth = leftWidth - repoWidth - statusWidth - 4;
  const table = (
    repo: string,
    description: string,
    status: string,
    marker = " ",
  ) =>
    `${marker} ${fit(repo, repoWidth)} ${fit(description, descriptionWidth)} ${fit(status, statusWidth)}`;
  const columnHeading = tabular
    ? table("Repository", "Session", "Status")
    : "Repository / Session / Status";
  const position = `${visible.length ? cursor + 1 : 0}/${visible.length}`;
  const filterLabel = view.filter;
  const filters =
    width >= 150
      ? ["all", "needs attention", "active", "review", "completed"]
          .map((label) => (label === filterLabel ? `[${label}]` : label))
          .join("  ")
      : `[${filterLabel}]  f status`;
  const controls =
    width >= 100
      ? `filter: ${filters}   repo: ${view.repository ? fit(basename(view.repository), 18).trimEnd() : "all repos"} (p)   sort: ${view.sort} (s)   / ${view.query || "search tasks"}`
      : `f ${view.filter}  p ${view.repository ? basename(view.repository) : "all repos"}  s ${view.sort}  / ${view.query || "search"}`;
  const lines = [
    width >= title.length + refresh.length + 3
      ? fit(title, width - refresh.length) + refresh
      : refresh,
    controls,
    wide
      ? fit(
          `Sessions  ${position}${pane.focused ? "" : " [focused]"}`,
          leftWidth,
        ) +
        " | " +
        `Selected item${pane.focused ? " [focused]" : ""}`
      : `Sessions ${position}  Enter for details`,
    wide ? fit(columnHeading, leftWidth) + " | " : columnHeading,
  ];
  const footer =
    width >= 100
      ? `Tab ${pane.focused ? "sessions" : "details"}   Up/Down/PgUp/PgDn ${pane.focused ? "scroll" : "select"}   Enter expand   / search   p repo   s sort   r refresh   q quit`
      : "Tab/Enter details  Up/Down select  f filter  p repo  s sort  q quit";
  const actions = "v validate   i integrate   R resume";
  const count = Math.max(1, height - lines.length - (wide ? 2 : 3));
  let start = Math.max(0, cursor);
  let used = rows[cursor] ? sessionRowHeight(rows[cursor]!, tabular) : 0;
  while (
    start > 0 &&
    used + sessionRowHeight(rows[start - 1]!, tabular) <= count
  ) {
    used += sessionRowHeight(rows[--start]!, tabular);
  }
  const details = selectedRow
    ? renderDetailPane(selectedRow, rightWidth, count, pane.offset).lines
    : ["Select a session to inspect its next action."];
  const listLines: string[] = [];
  for (let index = start; index < visible.length; index++) {
    const row = visible[index]!;
    const marker = index === cursor ? ">" : " ";
    const task = sessionCurrentTask(row.session);
    const rowLines = tabular
      ? [
          table(
            name(row),
            row.session?.taskSummary ?? "No session",
            sessionRowStatus(row),
            marker,
          ),
        ]
      : [
          `${marker} ${name(row)} | ${row.session?.taskSummary ?? "No session"}`,
        ];
    if (task)
      rowLines.push(
        tabular ? table("", `Task: ${task}`, "") : `  Task: ${task}`,
      );
    if (!tabular) rowLines.push(`  ${sessionRowStatus(row)}`);
    if (listLines.length && listLines.length + rowLines.length > count) break;
    listLines.push(...rowLines);
  }
  for (let i = 0; i < count; i++) {
    const left =
      listLines[i] ??
      (i === 0 && !rows.length
        ? "No matches. f changes filter; / searches."
        : "");
    lines.push(
      wide
        ? fit(left, leftWidth) + " | " + fit(details[i] ?? "", rightWidth)
        : left,
    );
  }
  if (!wide) lines.push(selectedRow ? `Next: ${nextStep(selectedRow)}` : "");
  lines.push(actions, footer);
  return lines.slice(0, height).map((line) => fit(line, width));
}

// Apply only owned escapes, after sanitizing saved text. Unicode is decorative;
// ASCII and basic ANSI colors remain available for conservative terminals.
export function colorDashboardLine(
  line: string,
  rich = false,
  unicode = false,
): string {
  const safe = terminalText(line);
  const base = rich ? "38;2;210;225;232;48;2;10;34;48" : "37;40";
  const accent = rich ? "38;2;135;215;205" : "96";
  const muted = rich ? "38;2;158;183;195" : "37";
  const selected = rich ? "38;2;240;248;252;48;2;48;86;109" : "44;97";
  const paint = (text: string, style: string) =>
    `\x1b[${style}m${text}\x1b[${base}m`;
  if (/^[+\/\\]-+[+\/\\]$/.test(safe)) {
    const corners = safe.startsWith("/")
      ? ["┌", "┐"]
      : safe.startsWith("\\")
        ? ["└", "┘"]
        : ["├", "┤"];
    return (
      paint(
        unicode ? corners[0] + "─".repeat(safe.length - 2) + corners[1] : safe,
        muted,
      ) + "\x1b[0m"
    );
  }
  if (safe.startsWith("| ") && safe.endsWith(" |")) {
    return (
      paint(unicode ? "│ " : "| ", muted) +
      colorDashboardLine(safe.slice(2, -2), rich, unicode) +
      paint(unicode ? " │" : " |", muted) +
      "\x1b[0m"
    );
  }
  // Shortcut-only rows use white keys and gray labels on the same background.
  if (
    /^(v validate|Tab(?:\/Enter)? |Up\/Down move|Esc cancel)/.test(
      safe.trimStart(),
    )
  ) {
    const shortcut = rich ? "38;2;255;255;255" : "97";
    const label = rich ? "38;2;170;170;170" : "37";
    const content = safe.replace(
      /(^| {2,})(\S+)(?= \S)/g,
      (_match, spacing: string, key: string) =>
        spacing + `\x1b[${shortcut}m${key}\x1b[${label}m`,
    );
    return `\x1b[${base};${label}m${content}\x1b[0m`;
  }
  const split = Math.floor(safe.length * 0.68);
  const divider =
    safe.length >= 110 && safe.slice(split, split + 3) === " | " ? split : -1;
  const left = divider >= 0 ? safe.slice(0, divider) : safe;
  const right = divider >= 0 ? safe.slice(divider + 3) : "";
  const decorate = (text: string) => {
    if (/^Status +\| +# +\| Task/.test(text))
      return `\x1b[1;${accent}m${text}\x1b[22;${base}m`;
    if (/^ +\| +\| {3}|^ {4}\S/.test(text)) return paint(text, muted);
    const taskStatus = text.match(
      /^(Pending|In progress|Completed|Blocked|Skipped)(?= +\|)/,
    )?.[1];
    if (taskStatus) {
      const color =
        taskStatus === "Blocked"
          ? "91"
          : taskStatus === "Completed"
            ? "92"
            : taskStatus === "In progress"
              ? "93"
              : muted;
      return paint(taskStatus, color) + text.slice(taskStatus.length);
    }

    const label = text.match(detailLabelPattern)?.[1];
    if (label)
      return `\x1b[1;${accent}m${label}\x1b[22;${base}m${text.slice(label.length)}`;
    return /^-{3,}\s*$/.test(text)
      ? paint(unicode ? text.replace(/-/g, "─") : text, muted)
      : text.replace(
          /\b(validation failed|merge conflict|needs review|needs attention|promotion pending|validation pending|active|ready|completed)\b/g,
          (match) =>
            paint(
              match,
              /failed|conflict|pending|attention/.test(match)
                ? "91"
                : match === "completed"
                  ? "92"
                  : /active|ready/.test(match)
                    ? "93"
                    : "94",
            ),
        );
  };
  const style =
    /^(sesh-integrator|Sessions|Next action|Selected item|Recent activity)/.test(
      safe.trim(),
    )
      ? accent
      : /^(filter:|f |repo |Up\/Down|v validate)/.test(safe.trim())
        ? muted
        : base;
  let content = /^\s+Task: /.test(left)
    ? paint(left, muted)
    : left.startsWith("> ")
      ? paint(left, selected)
      : paint(decorate(left), style);
  if (divider >= 0)
    content +=
      paint(unicode ? " │ " : " | ", muted) +
      paint(
        decorate(right),
        /^(Next action|Selected item|Recent activity)/.test(right)
          ? accent
          : base,
      );
  return `\x1b[${base}m${content}\x1b[0m`;
}

export async function dashboardCommand(): Promise<void> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY || process.env.TERM === "dumb")
    throw new Error(
      "dashboard requires an interactive terminal; use seshx status for plain output",
    );
  let allRows = await loadDashboard();
  let view = { ...defaultDashboardView };
  let rows = filterDashboard(allRows, view);
  let searching = false;
  let picker: DashboardPicker | undefined;
  let previousQuery = "";
  let refreshedAt = new Date();
  let stopWatching: (() => void) | undefined;
  let refreshPending = false;
  let refreshQueued = false;
  let selected = 0;
  let navigation: DashboardNavigation = {
    sessions: 0,
  };
  let mode: "list" | "details" | "form" | "confirm" | "output" = "list";
  let scroll = 0;
  let detailFocused = false;
  const detailOffsets = new Map<string, number>();
  const detailKey = () =>
    rows[selected]?.session?.id ?? rows[selected]?.repository?.path ?? "";
  const detailPage = () => {
    const width = Math.max(1, (stdout.columns || 80) - 1);
    const height = Math.max(1, (stdout.rows || 24) - (message ? 1 : 0));
    const framed = mode === "list" && width >= 114 && height >= 27;
    const innerWidth = width - (framed ? 4 : 0);
    const split = mode === "list" && innerWidth >= 110 && height >= 20;
    return renderDetailPane(
      rows[selected]!,
      split ? innerWidth - Math.floor(innerWidth * 0.68) - 3 : width,
      split ? height - (framed ? 7 : 0) - 6 : height - 2,
      detailOffsets.get(detailKey()) ?? 0,
    );
  };
  let message = "";
  let field: "summary" | "rollout" | "followUp" = "summary";
  let buffer = "";
  let input: IntegrationInput = { summary: "", rollout: "none", followUps: [] };
  let pending: DashboardAction = "integrate";
  let busy = false;
  let child: ChildProcess | undefined;
  let alternate = false;
  let closed = false;
  let terminating = false;
  let inputEpoch = 0;
  let keyQueue = Promise.resolve();
  const wasRaw = stdin.isRaw;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const enter = () => {
    if (!alternate) stdout.write("\x1b[?1049h\x1b[?25l");
    alternate = true;
  };
  const leave = () => {
    if (alternate) stdout.write("\x1b[?25h\x1b[?1049l");
    alternate = false;
  };
  const draw = () => {
    if (closed || busy || mode === "output") return;
    enter();
    const width = Math.max(1, (stdout.columns || 80) - 1);
    const height = Math.max(1, stdout.rows || 24);
    let lines: string[];
    let overlay: ReturnType<typeof dashboardPickerLayout> | undefined;
    if (
      mode === "list" &&
      detailFocused &&
      (width < 110 || height < 20) &&
      rows[selected]
    )
      mode = "details";
    if (width < 35 || height < 10) {
      lines = ["Terminal too small.", "Resize to at least 36 x 10.", "q quit"];
    } else if (mode === "list") {
      const offset = rows[selected] ? detailPage().offset : 0;
      if (rows[selected]) detailOffsets.set(detailKey(), offset);
      lines = renderDashboard(
        rows,
        selected,
        width,
        height - (message ? 1 : 0),
        refreshedAt,
        navigation,
        view,
        new Date(),
        {
          focused: detailFocused,
          offset,
        },
      );
      if (searching) {
        const framed = lines[0]?.startsWith("/");
        const available = width - (framed ? 4 : 0);
        const search = terminalText(
          `Search: ${view.query}_  Enter apply / Esc cancel`,
        )
          .slice(0, available)
          .padEnd(available);
        lines[framed ? 2 : 1] = framed ? `| ${search} |` : search;
      }
      if (picker) overlay = dashboardPickerLayout(lines, picker, width);
    } else if (mode === "details") {
      if (!rows[selected]) return;
      const page = detailPage();
      detailOffsets.set(detailKey(), page.offset);
      lines = [
        ...page.lines,
        "Up/Down/PgUp/PgDn scroll | Home/End",
        "Tab/Esc back  v/i/R actions  q quit",
      ];
    } else {
      const row = rows[selected];
      if (!row) return;
      let content: string[];
      let footer: string[];
      if (mode === "confirm") {
        content = [`Confirm ${pending}`, ...detailLines(row, false)];
        if (pending === "integrate")
          content.push(
            "",
            `Summary: ${input.summary}`,
            `Rollout: ${input.rollout}`,
            ...input.followUps.map((f) => `Follow-up: ${f}`),
          );
        footer = ["y run action | Esc cancel"];
      } else {
        content = [
          "Integrate session",
          `Session: ${row.session!.id}`,
          `Repository: ${row.repository!.path}`,
          `Target: ${targetBranch(row.repository!)}`,
          "",
          field === "summary"
            ? "Completion summary:"
            : field === "rollout"
              ? "Rollout: none / applied / automated / manual"
              : "Follow-up: action, destination, exact names (no secret values)",
          ...(field === "rollout"
            ? [
                "none: no external changes; applied: already applied",
                "automated: delegated; manual: requires follow-ups",
              ]
            : []),
          ...(field === "followUp"
            ? [
                "Enter each action separately; blank Enter finishes.",
                ...input.followUps.map((f) => `Added: ${f}`),
              ]
            : []),
          `> ${buffer}`,
        ];
        footer = ["Enter next | Backspace edit", "Esc cancel"];
      }
      const wrapped = wrapLines(content, width);
      const controls = wrapLines(footer, width);
      const count = Math.max(
        1,
        height - controls.length - 2 - (message ? 1 : 0),
      );
      if (mode === "form") scroll = Math.max(0, wrapped.length - count);
      scroll = Math.min(scroll, Math.max(0, wrapped.length - count));
      lines = [
        ...wrapped.slice(scroll, scroll + count),
        mode === "form"
          ? ""
          : `${scroll + 1}-${Math.min(wrapped.length, scroll + count)}/${wrapped.length} Up/Down scroll`,
        ...controls,
      ];
    }
    if (message) lines.push(message);
    const styleLine = (line: string) => {
      const safe = terminalText(line).slice(0, width);
      return mode === "list" && process.env.NO_COLOR === undefined
        ? colorDashboardLine(
            safe,
            /truecolor|24bit/.test(process.env.COLORTERM ?? ""),
            /utf-?8/i.test(
              process.env.LC_ALL ||
                process.env.LC_CTYPE ||
                process.env.LANG ||
                "",
            ),
          )
        : safe;
    };
    // Paint the dropdown independently after the dashboard so underlying row
    // selection and column styling cannot leak into its options or shortcuts.
    stdout.write(
      "\x1b[H\x1b[2J" +
        lines.slice(0, height).map(styleLine).join("\r\n") +
        (overlay
          ? overlay.box
              .map(
                (line, i) =>
                  `\x1b[${overlay.top + i + 1};${overlay.left + 1}H${styleLine(line)}`,
              )
              .join("")
          : ""),
    );
  };
  const refresh = async (followNewSession = true) => {
    const oldSession = rows[navigation.sessions];
    const wasAtTop = navigation.sessions === 0;
    const knownSessions = new Set(allRows.map((row) => row.session?.id));
    const id = rows[selected]?.session?.id;
    const path = rows[selected]?.repository?.path;
    allRows = await loadDashboard();
    rows = filterDashboard(allRows, view);
    refreshedAt = new Date();
    const found = rows.findIndex((r) =>
      id ? r.session?.id === id : r.repository?.path === path,
    );
    selected =
      found >= 0 ? found : Math.min(selected, Math.max(0, rows.length - 1));
    const preserve = (
      list: DashboardRow[],
      old: DashboardRow | undefined,
      fallback: number,
    ) => {
      const index = list.findIndex((r) =>
        old?.session
          ? r.session?.id === old.session.id
          : old?.repository && r.repository?.path === old.repository.path,
      );
      return index >= 0
        ? index
        : Math.max(0, Math.min(fallback, list.length - 1));
    };
    navigation.sessions = preserve(rows, oldSession, navigation.sessions);
    const topId = rows[0]?.session?.id;
    if (followNewSession && wasAtTop && topId && !knownSessions.has(topId)) {
      navigation.sessions = 0;
      scroll = 0;
    }
    selected = dashboardSelection(rows, navigation);
    if (!rows.length) mode = "list";
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stopWatching?.();
    leave();
    stdin.setRawMode(wasRaw);
    stdin.off("keypress", onKey);
    stdout.off("resize", draw);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    stdin.pause();
    finish();
  };
  const onInterrupt = () => {
    if (!busy) close();
  };
  const onTerminate = () => {
    terminating = true;
    if (child) child.kill("SIGTERM");
    else close();
  };
  const runAction = async () => {
    // Refresh the saved session before dispatch; the CLI itself remains the
    // authority for branch, commit, lock, dependency and recovery preconditions.
    inputEpoch++;
    const previous = JSON.stringify(rows[selected]);
    const previousTarget = rows[selected]?.repository
      ? targetBranch(rows[selected]!.repository!)
      : undefined;
    const id = rows[selected]?.session?.id;
    await refresh(false);
    const row = rows[selected];
    if (!row || row.session?.id !== id)
      throw new Error("Selected session disappeared; refresh and select again");
    if (
      JSON.stringify(row) !== previous ||
      (row.repository && targetBranch(row.repository) !== previousTarget)
    ) {
      mode = "details";
      throw new Error(
        "Session or configuration changed. Review details and choose the action again.",
      );
    }
    if (closed) return;
    const args = actionArguments(row, pending, input);
    leave();
    mode = "output";
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write(`\n${pending} ${terminalText(row.session!.id)}\n`);
    try {
      const result = await new Promise<string>((resolve, reject) => {
        child = spawn(
          process.execPath,
          [fileURLToPath(new URL("./cli.js", import.meta.url)), ...args],
          { cwd: row.session!.worktreePath, stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("close", (code, signal) =>
          resolve(
            signal
              ? `Stopped by ${signal}`
              : code === 0
                ? "Command completed"
                : `Command failed (exit ${code})`,
          ),
        );
      });
      stdout.write(`\n${result}. Enter returns to dashboard; q quits.\n`);
    } finally {
      child = undefined;
      stdin.setRawMode(true);
      stdin.resume();
      if (terminating) close();
    }
  };
  const applyView = () => {
    rows = filterDashboard(allRows, view);
    navigation = { sessions: 0 };
    selected = 0;
  };
  const handleKey = async (text: string, key: Key) => {
    if (closed || busy) return;
    if (key.ctrl && key.name === "c") {
      close();
      return;
    }
    if (mode === "output") {
      if (key.name === "q") close();
      else if (key.name === "return") {
        mode = "details";
        await refresh();
      }
      return;
    }
    if ((stdout.columns || 80) < 36 || (stdout.rows || 24) < 10) {
      if (key.name === "q") close();
      return;
    }
    if (mode === "list" && searching) {
      if (key.name === "escape") {
        view.query = previousQuery;
        searching = false;
      } else if (key.name === "return") searching = false;
      else if (key.name === "backspace") view.query = view.query.slice(0, -1);
      else if (
        text &&
        !key.ctrl &&
        !key.meta &&
        !/[\x00-\x1f\x7f-\x9f]/.test(text)
      )
        view.query += terminalText(text);
      applyView();
      return;
    }
    if (mode === "list" && picker) {
      if (key.name === "escape") picker = undefined;
      else if (key.name === "up" || key.name === "down")
        picker.selected = Math.max(
          0,
          Math.min(
            picker.options.length - 1,
            picker.selected + (key.name === "down" ? 1 : -1),
          ),
        );
      else if (key.name === "return") {
        const value = picker.options[picker.selected]!.value;
        if (picker.kind === "repository") view.repository = value;
        else view.sort = value as DashboardView["sort"];
        picker = undefined;
        applyView();
      }
      return;
    }
    if (
      mode === "list" &&
      (text === "/" ||
        ["f", "p", "s", "left", "right"].includes(key.name ?? ""))
    ) {
      if (text === "/") {
        previousQuery = view.query;
        searching = true;
      } else if (["f", "left", "right"].includes(key.name ?? "")) {
        const filters: DashboardView["filter"][] = [
          "all",
          "needs attention",
          "active",
          "review",
          "completed",
        ];
        view.filter =
          filters[
            (filters.indexOf(view.filter) +
              (key.name === "left" ? -1 : 1) +
              filters.length) %
              filters.length
          ]!;
        applyView();
      } else {
        const kind = key.name === "p" ? "repository" : "sort";
        const repos = [
          ...new Set(
            allRows
              .map((r) => r.repository?.path ?? r.session?.repositoryPath ?? "")
              .filter(Boolean),
          ),
        ].sort();
        const options =
          kind === "repository"
            ? [
                { value: "", label: "All repositories" },
                ...repos.map((value) => ({
                  value,
                  label: repos.some(
                    (other) =>
                      other !== value && basename(other) === basename(value),
                  )
                    ? value
                    : basename(value),
                })),
              ]
            : ["priority", "updated", "repository"].map((value) => ({
                value,
                label: value,
              }));
        picker = {
          kind,
          options,
          selected: Math.max(
            0,
            options.findIndex((o) => o.value === view[kind]),
          ),
        };
      }
      return;
    }
    if (mode === "form") {
      if (key.name === "escape") {
        mode = "details";
        scroll = 0;
        return;
      }
      if (key.name === "backspace") buffer = buffer.slice(0, -1);
      else if (key.name === "return") {
        const value = buffer.trim();
        if (field === "summary") {
          if (!value) throw new Error("Enter a completion summary");
          input.summary = value;
          field = "rollout";
        } else if (field === "rollout") {
          if (!["none", "applied", "automated", "manual"].includes(value))
            throw new Error("Choose none, applied, automated, or manual");
          input.rollout = value as RolloutDisposition;
          if (value === "manual") field = "followUp";
          else mode = "confirm";
        } else if (value) input.followUps.push(value);
        else {
          if (!input.followUps.length)
            throw new Error("Enter at least one manual follow-up");
          mode = "confirm";
        }
        buffer = "";
        scroll = 0;
      } else if (
        text &&
        !key.ctrl &&
        !key.meta &&
        !/[\x00-\x1f\x7f-\x9f]/.test(text)
      )
        buffer += text;
      return;
    }
    if (key.name === "escape") {
      mode = mode === "confirm" ? "details" : "list";
      scroll = 0;
      detailFocused = false;
      return;
    }
    if (mode === "confirm") {
      if (key.name === "y") await runAction();
      else if (key.name === "down") scroll++;
      else if (key.name === "up") scroll = Math.max(0, scroll - 1);
      return;
    }
    if (key.name === "q") {
      close();
      return;
    }
    if (key.name === "r" && !key.shift) {
      await refresh();
      return;
    }
    if (key.name === "tab") {
      if (mode === "details") {
        mode = "list";
        detailFocused = false;
      } else if (rows[selected]) {
        if ((stdout.columns || 80) - 1 >= 110 && (stdout.rows || 24) >= 20)
          detailFocused = !detailFocused;
        else mode = "details";
      }
      return;
    }
    if (
      ["down", "up", "pageup", "pagedown", "home", "end"].includes(
        key.name ?? "",
      )
    ) {
      if (rows[selected] && (mode === "details" || detailFocused)) {
        const page = detailPage();
        detailOffsets.set(
          detailKey(),
          scrollDetailPane(
            page.offset,
            key.name!,
            page.pageSize,
            page.maxOffset,
          ),
        );
      } else {
        const width = (stdout.columns || 80) - 1;
        const height = (stdout.rows || 24) - (message ? 1 : 0);
        const framed = width >= 114 && height >= 27;
        const innerWidth = width - (framed ? 4 : 0);
        const split = innerWidth >= 110 && height >= 20;
        const listWidth = split ? Math.floor(innerWidth * 0.68) : innerWidth;
        const available = Math.max(
          1,
          height - (framed ? 7 : 0) - (split ? 6 : 7),
        );
        const direction = key.name === "pageup" ? -1 : 1;
        let pageSize = 0;
        let used = 0;
        for (
          let index = navigation.sessions;
          index >= 0 && index < rows.length;
          index += direction
        ) {
          used += sessionRowHeight(rows[index]!, listWidth >= 70);
          if (used > available) break;
          pageSize++;
        }
        pageSize = Math.max(1, pageSize);
        navigation.sessions = scrollDetailPane(
          navigation.sessions,
          key.name!,
          pageSize,
          Math.max(0, rows.length - 1),
        );
        selected = dashboardSelection(rows, navigation);
      }
    } else if (key.name === "return" && rows[selected]) {
      mode = "details";
    } else if (
      rows[selected] &&
      (["v", "i", "s"].includes(key.name ?? "") ||
        (key.name === "r" && key.shift))
    ) {
      pending =
        key.name === "v"
          ? "validate"
          : key.name === "i"
            ? "integrate"
            : "resume";
      const reason = actionReason(rows[selected]!, pending);
      if (reason) throw new Error(reason);
      scroll = 0;
      if (pending === "integrate") {
        const session = rows[selected]!.session!;
        input = {
          summary: session.completionSummary ?? "",
          rollout: session.rolloutDisposition ?? "none",
          followUps: [...(session.rolloutFollowUps ?? [])],
        };
        if (
          session.status === "ready" &&
          session.rolloutDisposition &&
          session.completionSummary
        )
          mode = "confirm";
        else {
          mode = "form";
          field = "summary";
          buffer = input.summary;
        }
      } else mode = "confirm";
    }
  };
  const requestRefresh = () => {
    if (closed) return;
    refreshPending = true;
    if (refreshQueued) return;
    refreshQueued = true;
    // Share the input queue so asynchronous reads cannot race navigation edits.
    keyQueue = keyQueue.then(async () => {
      refreshQueued = false;
      if (
        closed ||
        busy ||
        searching ||
        picker ||
        (mode !== "list" && mode !== "details")
      )
        return;
      refreshPending = false;
      try {
        await refresh();
        if (message.startsWith("Refresh failed:")) message = "";
      } catch (error: unknown) {
        message = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      draw();
    });
  };
  const onKey = (text: string, key: Key) => {
    if (busy) return;
    const epoch = inputEpoch;
    keyQueue = keyQueue.then(async () => {
      if (closed || epoch !== inputEpoch) return;
      message = "";
      // handleKey executes synchronous edits before busy is set. Queueing also
      // preserves multiple keypresses delivered in the same terminal chunk.
      const operation = handleKey(text, key);
      busy = true;
      try {
        await operation;
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
        if (mode === "output")
          stdout.write(
            `\n${terminalText(message)}\nEnter returns to dashboard; q quits.\n`,
          );
      } finally {
        busy = false;
        draw();
        if (refreshPending) requestRefresh();
      }
    });
  };
  emitKeypressEvents(stdin);
  stdin.on("keypress", onKey);
  stdout.on("resize", draw);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    stdin.setRawMode(true);
    stdin.resume();
    draw();
    stopWatching = watchDashboard(requestRefresh);
    // Reconcile changes between the initial read and attaching the watchers.
    requestRefresh();
    await done;
  } finally {
    close();
  }
}
