import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
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

export function detailLines(row: DashboardRow): string[] {
  const { session: s, repository: r } = row;
  const lines = [
    `Repository: ${r?.path ?? s?.repositoryPath ?? "-"}`,
    `Target: ${r ? targetBranch(r) : (s?.targetBranch ?? "unregistered")}`,
  ];
  if (!s)
    return [
      ...lines,
      "No sessions. Run parallel-integrator begin from this repository.",
    ];
  lines.push(
    `Session: ${s.id}`,
    `Task: ${s.taskSummary}`,
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

export function needsAttention(row: DashboardRow): boolean {
  const s = row.session;
  return (
    !!s &&
    s.status !== "succeeded" &&
    (!row.repository ||
      !!s.validationFailure ||
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
  if (s.status === "succeeded") {
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
  focus: "sessions" | "attention";
  sessions: number;
  attention: number;
}

export function dashboardSelection(
  rows: DashboardRow[],
  nav: DashboardNavigation,
): number {
  return nav.focus === "sessions"
    ? nav.sessions
    : rows.indexOf(rows.filter(needsAttention)[nav.attention]!);
}

export function navigateDashboard(
  rows: DashboardRow[],
  nav: DashboardNavigation,
  key: "tab" | "up" | "down",
): DashboardNavigation {
  const next = { ...nav };
  if (key === "tab") {
    next.focus =
      nav.focus === "sessions" && rows.some(needsAttention)
        ? "attention"
        : "sessions";
  } else {
    const count =
      nav.focus === "sessions"
        ? rows.length
        : rows.filter(needsAttention).length;
    next[nav.focus] = Math.max(
      0,
      Math.min(count - 1, nav[nav.focus] + (key === "down" ? 1 : -1)),
    );
  }
  return next;
}

export function renderDashboard(
  rows: DashboardRow[],
  selected: number,
  width: number,
  height: number,
  refreshedAt = new Date(),
  navigation: DashboardNavigation = {
    focus: "sessions",
    sessions: selected,
    attention: 0,
  },
): string[] {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const clip = (value: string, size: number) => {
    const safe = terminalText(value);
    return safe.length <= size
      ? safe
      : size > 3
        ? safe.slice(0, size - 3) + "..."
        : safe.slice(0, size);
  };
  const fit = (value: string, size: number) => clip(value, size).padEnd(size);
  const panel = (
    title: string,
    content: string[],
    size: number,
    count: number,
    focused = false,
  ) => [
    `${focused ? "+= " : "+- "}${fit(title + (focused ? " [focused]" : ""), size - 5)}${focused ? "=+" : "-+"}`,
    ...Array.from(
      { length: count },
      (_, i) => `| ${fit(content[i] ?? "", size - 4)} |`,
    ),
    `+${(focused ? "=" : "-").repeat(size - 2)}+`,
  ];
  const sessions = rows.flatMap((r) => (r.session ? [r.session] : []));
  const blocked = rows.filter(needsAttention).length;
  const active = rows.filter(
    (r) => r.session?.status === "active" && !needsAttention(r),
  ).length;
  const ready = rows.filter(
    (r) => r.session?.status === "ready" && !needsAttention(r),
  ).length;
  const today = refreshedAt.toISOString().slice(0, 10);
  const completed = sessions.filter(
    (s) =>
      s.status === "succeeded" &&
      (s.remotePromotedAt ?? s.promotedAt)?.slice(0, 10) === today,
  ).length;
  const selectedRow = rows[selected];
  const summary = `${active} active | ${ready} ready | ${blocked} blocked | ${completed} completed today (UTC)`;
  const attention = rows.filter(needsAttention);
  const focusedRows = navigation.focus === "attention" ? attention : rows;
  const cursor = navigation[navigation.focus];
  const position = `${focusedRows.length ? cursor + 1 : 0}/${focusedRows.length}`;
  const footer = `${position} Tab panel | Up/Down select | Enter details | r refresh | q quit`;
  const actions = "v validate | i integrate | R resume";
  const name = (r: DashboardRow) =>
    basename(r.repository?.path ?? r.session?.repositoryPath ?? "-");
  const target = (r: DashboardRow) =>
    r.repository
      ? targetBranch(r.repository)
      : (r.session?.targetBranch ?? "?");
  // Small terminals retain every session and full details via Enter.
  if (width < 100 || height < 28) {
    const count = Math.max(1, height - 7);
    const start = Math.max(0, cursor - count + 1);
    return [
      "parallel-integrator",
      summary,
      `${navigation.focus === "attention" ? "Needs attention" : "Sessions"} [focused] - Tab panel`,
      ...focusedRows
        .slice(start, start + count)
        .map(
          (r, i) =>
            `${start + i === cursor ? ">" : " "} ${name(r)} | ${stateLabel(r)} | ${r.session?.taskSummary ?? "Run begin"}`,
        ),
      ...(!rows.length ? ["No repositories or sessions. Run register."] : []),
      selectedRow ? `Next: ${nextStep(selectedRow)}` : "",
      actions,
      footer,
    ]
      .slice(0, height)
      .map((l) => clip(l, width));
  }
  const attentionCount = Math.min(4, Math.max(1, attention.length));
  const selectedAttention = navigation.attention;
  const attentionStart = Math.max(0, selectedAttention - attentionCount + 1);
  const col = Math.floor((width - 10) * 0.19);
  const attentionLines = attention
    .slice(attentionStart, attentionStart + attentionCount)
    .map(
      (r) =>
        `${navigation.focus === "attention" && r === attention[navigation.attention] ? ">" : " "} ${fit(stateLabel(r), col)} ${fit(name(r), col)} ${fit(r.session!.taskSummary, col + 6)} ${nextStep(r)}`,
    );
  const lines = [
    `parallel-integrator${" ".repeat(Math.max(1, width - 53))}Last refresh ${refreshedAt.toISOString().slice(11, 19)} UTC`,
    ...panel(summary, [], width, 0),
    ...panel(
      `Needs attention (${attention.length})${attention.length > attentionCount ? " - scroll for more" : ""}`,
      attention.length ? attentionLines : ["No integration blockers recorded."],
      width,
      attentionCount,
      navigation.focus === "attention",
    ),
  ];
  const bodyHeight = height - lines.length - 2;
  const leftWidth = Math.floor(width * 0.48);
  const rightWidth = width - leftWidth - 1;
  const repoHeight = Math.max(5, Math.floor(bodyHeight * 0.48));
  const sessionHeight = bodyHeight - repoHeight;
  const repositories = new Map<string, DashboardRow[]>();
  for (const r of rows) {
    const path = r.repository?.path ?? r.session!.repositoryPath;
    repositories.set(path, [...(repositories.get(path) ?? []), r]);
  }
  const repoRows = [...repositories.values()];
  const selectedRepo = repoRows.findIndex(
    (group) => selectedRow && group.includes(selectedRow),
  );
  const repoCount = repoHeight - 3;
  const repoStart = Math.max(0, selectedRepo - repoCount + 1);
  const repoLines = repoRows
    .slice(repoStart, repoStart + repoCount)
    .map((group) => {
      const r =
        group.find(needsAttention) ??
        group.find((r) => r.session && r.session.status !== "succeeded") ??
        group[0]!;
      return `${fit(name(r), 18)} ${fit(target(r), 10)} ${stateLabel(r)}`;
    });
  const sessionCount = sessionHeight - 2;
  const sessionStart = Math.max(0, navigation.sessions - sessionCount + 1);
  const left = [
    ...panel(
      `Repository overview (${repoRows.length})`,
      ["REPOSITORY         TARGET     STATE", ...repoLines],
      leftWidth,
      repoHeight - 2,
    ),
    ...panel(
      `Sessions ${rows.length ? navigation.sessions + 1 : 0}/${rows.length}`,
      rows.length
        ? rows
            .slice(sessionStart, sessionStart + sessionCount)
            .map(
              (r, i) =>
                `${navigation.focus === "sessions" && sessionStart + i === navigation.sessions ? ">" : " "} ${name(r)} | ${stateLabel(r)} | ${r.session?.taskSummary ?? "Run begin"}`,
            )
        : ["No repositories. Run register to start."],
      leftWidth,
      sessionCount,
      navigation.focus === "sessions",
    ),
  ];
  const activityHeight = Math.max(5, Math.floor(bodyHeight * 0.42));
  const events = dashboardActivity(rows);
  const activity = events.map(
    (e) => `${e.at.slice(0, 10)} ${e.at.slice(11, 19)} ${e.text}`,
  );
  const s = selectedRow?.session;
  const details = selectedRow
    ? [
        `Repository: ${name(selectedRow)} / ${target(selectedRow)}`,
        `Task: ${s?.taskSummary ?? "No session"}`,
        `Branch: ${s?.branch ?? "-"}`,
        `Session: ${s?.id ?? "-"}`,
        `Status: ${stateLabel(selectedRow)}`,
        `Next: ${nextStep(selectedRow)}`,
        ...(s?.latestError ? [`Error: ${s.latestError}`] : []),
        "Enter for full details, errors and follow-ups",
      ]
    : ["Select a session to inspect its next action."];
  const right = [
    ...panel(
      "Recent activity (UTC, saved milestones)",
      events.length ? activity : ["No recorded activity."],
      rightWidth,
      activityHeight - 2,
    ),
    ...panel(
      "Selected item",
      details,
      rightWidth,
      bodyHeight - activityHeight - 2,
    ),
  ];
  lines.push(...left.map((line, i) => `${line} ${right[i]}`), actions, footer);
  return lines.map((l) => clip(l, width));
}

// Only paint sanitized, clipped renderer output; persisted text cannot inject ANSI.
export function colorDashboardLine(line: string): string {
  const safe = terminalText(line);
  const color = /(?:^|\| )> /.test(safe)
    ? "44;97"
    : /Needs attention|merge conflict|validation failed/.test(safe)
      ? "91"
      : /pending|blocked/.test(safe)
        ? "93"
        : /completed|validated|promoted/.test(safe)
          ? "92"
          : /parallel-integrator|Repository overview|Recent activity|Selected item|Sessions/.test(
                safe,
              )
            ? "96"
            : "";
  return color ? `\x1b[${color}m${safe}\x1b[0m` : safe;
}

export async function dashboardCommand(): Promise<void> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY || process.env.TERM === "dumb")
    throw new Error(
      "dashboard requires an interactive terminal; use parallel-integrator status for plain output",
    );
  let rows = orderDashboard(await loadDashboard());
  let refreshedAt = new Date();
  let selected = 0;
  let navigation: DashboardNavigation = {
    focus: "sessions",
    sessions: 0,
    attention: 0,
  };
  let mode: "list" | "details" | "form" | "confirm" | "output" = "list";
  let scroll = 0;
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
    if (width < 35 || height < 10) {
      lines = ["Terminal too small.", "Resize to at least 36 x 10.", "q quit"];
    } else if (mode === "list") {
      lines = renderDashboard(
        rows,
        selected,
        width,
        height - (message ? 1 : 0),
        refreshedAt,
        navigation,
      );
    } else {
      const row = rows[selected];
      if (!row) return;
      let content: string[];
      let footer: string[];
      if (mode === "details") {
        content = [
          ...detailLines(row),
          "",
          ...(["validate", "integrate", "resume"] as const).map(
            (a) =>
              `${a === "resume" ? "R" : a[0]} ${a}: ${actionReason(row, a) ?? "available"}`,
          ),
        ];
        footer = [
          "v validate | i integrate | R resume",
          "Esc back | r refresh | q quit",
        ];
      } else if (mode === "confirm") {
        content = [`Confirm ${pending}`, ...detailLines(row)];
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
    stdout.write(
      "\x1b[H\x1b[2J" +
        lines
          .slice(0, height)
          .map((line) => {
            const safe = terminalText(line).slice(0, width);
            return mode === "list" && process.env.NO_COLOR === undefined
              ? colorDashboardLine(safe)
              : safe;
          })
          .join("\r\n"),
    );
  };
  const refresh = async () => {
    const oldSession = rows[navigation.sessions];
    const oldAttention = rows.filter(needsAttention)[navigation.attention];
    const id = rows[selected]?.session?.id;
    const path = rows[selected]?.repository?.path;
    rows = orderDashboard(await loadDashboard());
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
    const attention = rows.filter(needsAttention);
    navigation.attention = preserve(
      attention,
      oldAttention,
      navigation.attention,
    );
    if (!attention.length) {
      if (navigation.focus === "attention") navigation.sessions = selected;
      navigation.focus = "sessions";
    }
    selected = dashboardSelection(rows, navigation);
    if (!rows.length) mode = "list";
  };
  const close = () => {
    if (closed) return;
    closed = true;
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
    await refresh();
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
    if (mode === "list" && key.name === "tab") {
      navigation = navigateDashboard(rows, navigation, "tab");
      selected = dashboardSelection(rows, navigation);
      return;
    }
    if (key.name === "down" || key.name === "up") {
      const delta = key.name === "down" ? 1 : -1;
      if (mode === "list") {
        navigation = navigateDashboard(rows, navigation, key.name);
        selected = dashboardSelection(rows, navigation);
      } else scroll = Math.max(0, scroll + delta);
    } else if (key.name === "return" && rows[selected]) {
      mode = "details";
      scroll = 0;
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
    await done;
  } finally {
    close();
  }
}
