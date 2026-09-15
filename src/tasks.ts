import { stripVTControlCharacters } from "node:util";
import { resolveSourceSession } from "./handoff.js";
import { readSession, updateSessionTasks } from "./runtime.js";
import type { Session, SessionTask, TaskStatus } from "./types.js";

const statuses: TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "skipped",
];
const sessionStatuses: Session["status"][] = [
  "active",
  "ready",
  "validation_pending",
  "promotion_pending",
  "needs_review",
  "succeeded",
];
const markers: Record<TaskStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  blocked: "[!]",
  skipped: "[-]",
};

export function taskProgress(session?: Session): string {
  const tasks = session?.tasks ?? [];
  if (!tasks.length) return "No tasks yet";
  const completed = tasks.filter((t) => t.status === "completed").length;
  const skipped = tasks.filter((t) => t.status === "skipped").length;
  return `${completed}/${tasks.length} completed${skipped ? `, ${skipped} skipped` : ""}`;
}

export function currentTask(session?: Session): string {
  const tasks = session?.tasks ?? [];
  if (!tasks.length) return "No tasks yet";
  const active = tasks.find((t) => t.status === "in_progress");
  if (active) return active.title;
  if (tasks.every((t) => ["completed", "skipped"].includes(t.status)))
    return "Complete";
  if (tasks.some((t) => t.status === "blocked")) return "Blocked";
  return tasks.every((t) => t.status === "pending")
    ? "Not started"
    : "Between tasks";
}

export function taskLines(session: Session, compact = false): string[] {
  const tasks = session.tasks ?? [];
  if (!tasks.length)
    return ['No tasks yet. Use seshx tasks add --title "...".'];
  return tasks.flatMap((task, index) => [
    `${index + 1}. ${markers[task.status]} ${task.title}${compact ? "" : ` (${task.status.replaceAll("_", " ")}; id ${task.id})`}`,
    ...(task.description ? [`   ${task.description}`] : []),
    ...(task.reason ? [`   Reason: ${task.reason}`] : []),
  ]);
}

type TaskEdit =
  | { action: "add"; titles: string[]; description?: string | undefined }
  | {
      action: "update";
      id: number;
      title?: string | undefined;
      description?: string | undefined;
      status?: TaskStatus | undefined;
      reason?: string | undefined;
    }
  | { action: "move"; id: number; position: number };

/** Operates on a copy so rejected edits never alter the saved checklist. */
export function editTasks(
  tasks: SessionTask[],
  edit: TaskEdit,
  now = new Date().toISOString(),
): SessionTask[] {
  const result = tasks.map((task) => ({ ...task }));
  if (edit.action === "add") {
    let id = Math.max(0, ...tasks.map((t) => t.id));
    for (const title of edit.titles) {
      if (!title.trim()) throw new Error("Task title must not be empty");
      result.push({
        id: ++id,
        title: title.trim(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
        ...(edit.description ? { description: edit.description.trim() } : {}),
      });
    }
    return result;
  }
  const index = result.findIndex((task) => task.id === edit.id);
  if (index < 0) throw new Error(`Unknown task ID: ${edit.id}`);
  const task = result[index]!;
  if (edit.action === "move") {
    if (
      !Number.isInteger(edit.position) ||
      edit.position < 1 ||
      edit.position > result.length
    )
      throw new Error(`Position must be between 1 and ${result.length}`);
    result.splice(index, 1);
    result.splice(edit.position - 1, 0, task);
  } else {
    if (edit.title !== undefined) {
      if (!edit.title.trim()) throw new Error("Task title must not be empty");
      task.title = edit.title.trim();
    }
    if (edit.description !== undefined) {
      if (edit.description.trim()) task.description = edit.description.trim();
      else delete task.description;
    }
    if (edit.status !== undefined) {
      if (!statuses.includes(edit.status))
        throw new Error(`Status must be ${statuses.join(", ")}`);
      if (edit.status !== task.status) delete task.reason;
      task.status = edit.status;
    }
    if (edit.reason !== undefined) {
      if (edit.reason.trim()) task.reason = edit.reason.trim();
      else delete task.reason;
    }
    if (["blocked", "skipped"].includes(task.status)) {
      if (!task.reason) throw new Error(`${task.status} requires --reason`);
    } else if (task.reason)
      throw new Error("--reason is only for blocked or skipped tasks");
    if (
      task.status === "in_progress" &&
      result.some((t) => t.id !== task.id && t.status === "in_progress")
    )
      throw new Error(
        "Only one task may be in progress. Update the current task first.",
      );
  }
  task.updatedAt = now;
  return result;
}

const usage = `Usage:
  seshx tasks list [--session <id>]
  seshx tasks add --title "..." [--title "..."]... [--description "..."] [--session <id>]
  seshx tasks update <task-id> [--title "..."] [--description "..."] [--status pending|in_progress|completed|blocked|skipped] [--reason "..."] [--session <id>]
  seshx tasks move <task-id> --position <n> [--session <id>]`;

export async function tasksCommand(args: string[]): Promise<void> {
  const [action = "list", ...rest] = args;
  if (!["list", "add", "update", "move"].includes(action))
    throw new Error(usage);
  const options = new Map<string, string>();
  const titles: string[] = [];
  const id =
    action === "update" || action === "move" ? Number(rest.shift()) : undefined;
  if (id !== undefined && (!Number.isSafeInteger(id) || id < 1))
    throw new Error(usage);
  const allowed =
    action === "list"
      ? ["--session"]
      : action === "add"
        ? ["--session", "--title", "--description"]
        : action === "move"
          ? ["--session", "--position"]
          : ["--session", "--title", "--description", "--status", "--reason"];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!;
    const value = rest[i + 1];
    if (!allowed.includes(key) || value === undefined || value.startsWith("--"))
      throw new Error(usage);
    if (action === "add" && key === "--title") titles.push(value);
    else {
      if (options.has(key))
        throw new Error(`${key} may be specified only once`);
      options.set(key, value);
    }
  }
  const sessionId = options.get("--session");
  if (sessionId !== undefined && !/^[a-zA-Z0-9_-]+$/.test(sessionId))
    throw new Error("Invalid session ID");
  // Explicit inspection remains possible outside the repo and after its removal.
  let session =
    action === "list" && sessionId
      ? await readSession(sessionId)
      : (
          await resolveSourceSession(
            sessionStatuses,
            sessionId,
            action !== "list",
          )
        ).session;
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  if (action !== "list") {
    let edit: TaskEdit;
    if (action === "add") {
      if (!titles.length) throw new Error(usage);
      edit = { action, titles, description: options.get("--description") };
    } else if (action === "move") {
      edit = { action, id: id!, position: Number(options.get("--position")) };
    } else {
      if (![...options.keys()].some((key) => key !== "--session"))
        throw new Error(usage);
      edit = {
        action: "update",
        id: id!,
        title: options.get("--title"),
        description: options.get("--description"),
        status: options.get("--status") as TaskStatus | undefined,
        reason: options.get("--reason"),
      };
    }
    session = await updateSessionTasks(session.id, (tasks) =>
      editTasks(tasks, edit),
    );
  }
  const lines = [
    `Tasks for ${session.id}: ${taskProgress(session)}`,
    `Current: ${currentTask(session)}`,
    ...taskLines(session),
  ];
  process.stdout.write(
    lines
      .map((line) =>
        stripVTControlCharacters(line).replace(/[^\x20-\x7e]/g, "?"),
      )
      .join("\n") + "\n",
  );
}
