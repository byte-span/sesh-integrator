import { run } from "./process.js";

// A manual follow-up names the open task that covers it, so no outstanding
// action is reported without tracked work. The pull request's own review and
// merge is tracked by the pull request and is never declared as a follow-up.
export const TASK_REGISTER = "TASKS.json";
const OPEN_STATUSES = new Set(["ready", "in_progress", "blocked"]);
const REFERENCE = /^([A-Za-z0-9][A-Za-z0-9._-]*):\s+\S/;

export function followUpTaskId(followUp: string): string | undefined {
  return REFERENCE.exec(followUp)?.[1];
}

export function parseTaskRegister(text: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${TASK_REGISTER} at the source commit is not valid JSON`);
  }
  const tasks = (parsed as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) {
    throw new Error(`${TASK_REGISTER} at the source commit has no tasks list`);
  }
  const statuses = new Map<string, string>();
  for (const task of tasks) {
    const { id, status } = (task ?? {}) as { id?: unknown; status?: unknown };
    if (typeof id === "string" && typeof status === "string") {
      statuses.set(id, status);
    }
  }
  return statuses;
}

export function checkTrackedFollowUps(
  followUps: string[],
  register: string | undefined,
): void {
  if (!followUps.length) return;
  const untracked = followUps.find((item) => !followUpTaskId(item));
  if (untracked !== undefined) {
    throw new Error(
      `Each --follow-up must start with the ID of the open task that covers it, for example "PC-006: Deploy ...". ` +
        `If no task covers it, add or update one in ${TASK_REGISTER} in this session first.`,
    );
  }
  if (register === undefined) {
    throw new Error(
      `This repository has no ${TASK_REGISTER} at the source commit, so a manual follow-up cannot be tracked. ` +
        `Ask the user where to track the action (for example, add ${TASK_REGISTER} with qtask and a task for it in this session), then reference that task.`,
    );
  }
  const tasks = parseTaskRegister(register);
  for (const item of followUps) {
    const id = followUpTaskId(item)!;
    const status = tasks.get(id);
    if (status === undefined) {
      throw new Error(
        `--follow-up references ${id}, which is not a task in ${TASK_REGISTER} at the source commit. Add or update the task in this session, then integrate.`,
      );
    }
    if (!OPEN_STATUSES.has(status)) {
      throw new Error(
        `--follow-up references ${id}, which is ${status}. Reference the open task that covers the action, or reopen or add one.`,
      );
    }
  }
}

export async function readTaskRegister(
  worktreePath: string,
  commit: string,
): Promise<string | undefined> {
  const present = await run(
    "git",
    ["cat-file", "-e", `${commit}:${TASK_REGISTER}`],
    {
      cwd: worktreePath,
    },
  );
  if (present.code !== 0) return undefined;
  const shown = await run("git", ["show", `${commit}:${TASK_REGISTER}`], {
    cwd: worktreePath,
  });
  if (shown.code !== 0) {
    throw new Error(`Could not read ${TASK_REGISTER} at the source commit`);
  }
  return shown.stdout;
}
