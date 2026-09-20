import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  actionArguments,
  actionReason,
  dashboardActivity,
  detailLines,
  filterDashboard,
  defaultDashboardView,
  loadDashboard,
  needsAttention,
  type DashboardRow,
  type IntegrationInput,
} from "./dashboard.js";
import { watchDashboard } from "./dashboard-watch.js";
import { currentTask, taskProgress } from "./tasks.js";
import { targetBranch } from "./promotion.js";
import { webHtml, webCss, webScript } from "./dashboard-web-assets.js";

export interface WebOptions {
  port: number;
  open: boolean;
}
export function parseWebOptions(args: string[]): WebOptions {
  const result = { port: 0, open: true };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error(`Duplicate dashboard option: ${arg}`);
    seen.add(arg);
    if (arg === "--web") continue;
    if (arg === "--no-open") result.open = false;
    else if (arg === "--port") {
      const value = args[++i] ?? "";
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error("Dashboard port must be between 1 and 65535");
      result.port = Number(value);
    } else throw new Error(`Unknown dashboard option: ${arg}`);
  }
  if (!seen.has("--web")) throw new Error("Use --web with --no-open or --port");
  return result;
}

export function webRevision(row: DashboardRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row,
        row.repository ? targetBranch(row.repository) : null,
      ]),
    )
    .digest("hex");
}

function nextAction(row: DashboardRow): string {
  const s = row.session;
  if (!s) return "Run seshx begin in this repository to start a session.";
  if (!row.repository)
    return "Restore this repository's registration before running an action.";
  if (s.status === "succeeded" || s.status === "no_changes")
    return s.pullRequestUrl || s.rolloutFollowUps?.length
      ? "Review the pull request and complete any outstanding follow-ups below."
      : "This session is finished. Its saved details remain available below.";
  if (s.waitingForLock)
    return "The session is waiting for the repository lock.";
  if (s.awaitingConflictResolution)
    return "Resolve and stage conflicts in the integration worktree, then choose Resume.";
  if (!actionReason(row, "resume"))
    return "Inspect the recovery details below, then choose Resume when ready.";
  if (s.validationFailure || s.latestError)
    return "Inspect the saved error below before retrying validation.";
  return s.sourceValidatedCommit
    ? "Review the validated source and choose Integrate."
    : "Commit your source changes, then choose Validate.";
}

export function webRow(row: DashboardRow) {
  const s = row.session;
  const repository = row.repository?.path ?? s?.repositoryPath ?? "";
  const times = [
    s?.startedAt,
    s?.tasksUpdatedAt,
    s?.closedAt,
    s?.readyAt,
    s?.sourceValidatedAt,
    s?.integratedAt,
    s?.promotedAt,
    s?.remotePromotedAt,
    s?.validationFailure?.failedAt,
  ];
  return {
    id: s?.id ?? `repository:${repository}`,
    revision: webRevision(row),
    repository,
    repositoryName: basename(repository),
    registered: !!row.repository,
    title: s?.taskSummary ?? "No sessions yet",
    branch: s?.branch ?? "",
    status: s?.status ?? "empty",
    attention: needsAttention(row),
    updated: Math.max(0, ...times.map((t) => (t ? Date.parse(t) || 0 : 0))),
    progress: taskProgress(s),
    current: s?.status === "succeeded" ? "Complete" : currentTask(s),
    tasks: s?.tasks ?? [],
    next: nextAction(row),
    details: detailLines(row, false),
    activity: dashboardActivity([row]),
    followUps: s?.rolloutFollowUps ?? [],
    pullRequestUrl: /^https:\/\//.test(s?.pullRequestUrl ?? "")
      ? s!.pullRequestUrl
      : undefined,
    actions: Object.fromEntries(
      (["validate", "integrate", "resume"] as const).map((a) => [
        a,
        actionReason(row, a) ?? null,
      ]),
    ),
    editable: !!s && !!row.repository,
    rollout: s?.rolloutDisposition ?? "none",
    summary: s?.completionSummary ?? "",
  };
}

interface ActionRequest {
  session: string;
  revision: string;
  action: string;
  input?: IntegrationInput;
  task?: { id?: number; title?: string; status?: string; reason?: string };
}

export function webActionArguments(
  row: DashboardRow,
  request: ActionRequest,
): string[] {
  if (!row.session || !row.repository)
    throw new Error("Select a registered session");
  if (request.revision !== webRevision(row))
    throw new Error(
      "Session or configuration changed. Close this form, review the refreshed details, and try again.",
    );
  if (["validate", "resume", "integrate"].includes(request.action)) {
    if (request.action === "integrate") {
      const input = request.input;
      if (
        !input ||
        typeof input.summary !== "string" ||
        !Array.isArray(input.followUps) ||
        input.followUps.some((f) => typeof f !== "string")
      )
        throw new Error("Enter a summary and valid rollout follow-ups");
    }
    return actionArguments(
      row,
      request.action as "validate" | "resume" | "integrate",
      request.input,
    );
  }
  const task = request.task;
  if (
    request.action === "task-add" &&
    typeof task?.title === "string" &&
    task.title.trim()
  )
    return [
      "tasks",
      "add",
      "--session",
      row.session.id,
      "--title",
      task.title.trim(),
    ];
  if (
    request.action === "task-update" &&
    Number.isSafeInteger(task?.id) &&
    row.session.tasks?.some((t) => t.id === task!.id)
  ) {
    if (
      !["pending", "in_progress", "completed", "blocked", "skipped"].includes(
        task?.status ?? "",
      )
    )
      throw new Error("Choose a valid task status");
    const args = [
      "tasks",
      "update",
      String(task!.id),
      "--session",
      row.session.id,
      "--status",
      task!.status!,
    ];
    if (["blocked", "skipped"].includes(task!.status!) && !task?.reason?.trim())
      throw new Error("Blocked or skipped tasks require a reason");
    if (task?.reason) args.push("--reason", task.reason);
    return args;
  }
  throw new Error("Unknown dashboard action or invalid task");
}

export type WebRunner = (
  row: DashboardRow,
  args: string[],
  output: (chunk: string) => void,
) => Promise<number>;
export const runWebCommand: WebRunner = async (row, args, output) => {
  const cli =
    row.session!.recoveryCoordinator?.cliPath ??
    row.session!.coordinator?.cliPath ??
    fileURLToPath(new URL("./cli.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: row.session!.worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1" },
    });
    child.stdout.setEncoding("utf8").on("data", output);
    child.stderr.setEncoding("utf8").on("data", output);
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
};

async function readRequest(req: IncomingMessage): Promise<ActionRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) throw new Error("Request too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid action request");
  const v = value as ActionRequest;
  if (
    typeof v.session !== "string" ||
    typeof v.revision !== "string" ||
    typeof v.action !== "string"
  )
    throw new Error("Invalid action request");
  return v;
}

export async function startWebDashboard(
  options: {
    port?: number;
    load?: typeof loadDashboard;
    run?: WebRunner;
    watch?: typeof watchDashboard;
  } = {},
) {
  const load = options.load ?? loadDashboard;
  const run = options.run ?? runWebCommand;
  const clients = new Set<ServerResponse>();
  let origin = "";
  let closing = false;
  let reserved = false;
  let admission: Promise<void> | undefined;
  let operation: Promise<void> | undefined;
  let job: {
    session: string;
    action: string;
    running: boolean;
    output: string;
    code?: number;
  } | null = null;
  const notify = () => {
    for (const client of clients) client.write("event: change\ndata: {}\n\n");
  };
  const json = (res: ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    // Loopback binding alone is insufficient: reject DNS rebinding and cross-site reads/writes.
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      ["cross-site", "same-site"].includes(
        req.headers["sec-fetch-site"] as string,
      )
    ) {
      json(res, 403, {
        error: "Only same-origin local dashboard requests are allowed",
      });
      return;
    }
    try {
      if (closing) {
        json(res, 503, { error: "Dashboard is shutting down" });
        return;
      }
      if (req.method === "GET") {
        if (req.url === "/favicon.ico") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (
          req.url === "/" ||
          req.url === "/app.css" ||
          req.url === "/app.js"
        ) {
          const asset =
            req.url === "/"
              ? ["text/html", webHtml]
              : req.url === "/app.css"
                ? ["text/css", webCss]
                : ["text/javascript", webScript];
          res.writeHead(200, { "Content-Type": `${asset[0]}; charset=utf-8` });
          res.end(asset[1]);
          return;
        }
        if (req.url === "/api/state") {
          const rows = filterDashboard(await load(), {
            ...defaultDashboardView,
            filter: "all",
            sort: "updated",
          });
          json(res, 200, {
            rows: rows.map(webRow),
            job,
            refreshedAt: new Date().toISOString(),
          });
          return;
        }
        if (req.url === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
          });
          res.write("event: change\ndata: {}\n\n");
          clients.add(res);
          res.on("close", () => clients.delete(res));
          return;
        }
      }
      if (req.method === "POST" && req.url === "/api/action") {
        if (
          req.headers.origin !== origin ||
          req.headers["x-sesh-dashboard"] !== "1" ||
          req.headers["content-type"] !== "application/json"
        ) {
          json(res, 403, {
            error: "Actions require a same-origin dashboard request",
          });
          return;
        }
        if (reserved || job?.running) {
          json(res, 409, { error: "A dashboard command is already running" });
          return;
        }
        reserved = true;
        let admitted!: () => void;
        admission = new Promise<void>((resolve) => {
          admitted = resolve;
        });
        try {
          const request = await readRequest(req);
          const row = (await load()).find(
            (r) => r.session?.id === request.session,
          );
          if (closing) throw new Error("Dashboard is shutting down");
          if (!row) throw new Error("Session no longer exists");
          const args = webActionArguments(row, request);
          job = {
            session: request.session,
            action: request.action,
            running: true,
            output: "",
          };
          const active = job;
          operation = (async () => {
            try {
              active.code = await run(row, args, (chunk) => {
                active.output = (
                  active.output + stripVTControlCharacters(chunk)
                ).slice(-131_072);
              });
            } catch (error) {
              active.code = 1;
              active.output += `\n${error instanceof Error ? error.message : "Command failed"}`;
            } finally {
              active.running = false;
              notify();
            }
          })();
          json(res, 202, { accepted: true });
          notify();
        } finally {
          reserved = false;
          admitted();
        }
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 400, {
        error:
          error instanceof Error ? error.message : "Unable to load dashboard",
      });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to listen on localhost");
  origin = `http://127.0.0.1:${address.port}`;
  const stopWatching = (options.watch ?? watchDashboard)(notify);
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n");
    if (job?.running) notify();
  }, 1000);
  heartbeat.unref();
  let stop: Promise<void> | undefined;
  return {
    url: origin,
    get busy() {
      return reserved || !!job?.running;
    },
    close(): Promise<void> {
      if (stop) return stop;
      closing = true;
      stop = (async () => {
        await admission;
        await operation;
        stopWatching();
        clearInterval(heartbeat);
        for (const client of clients) client.end();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      })();
      return stop;
    },
  };
}

export function openWebBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timeout = setTimeout(() => {
      child.unref();
      resolve();
    }, 3000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve()
        : reject(new Error("Browser launcher unavailable"));
    });
  });
}

export async function webDashboardCommand(args: string[]): Promise<void> {
  const options = parseWebOptions(args);
  const dashboard = await startWebDashboard(options);
  process.stdout.write(
    `Local dashboard: ${dashboard.url}\nPress Ctrl+C to stop. Closing the browser tab leaves the dashboard running.\n`,
  );
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (dashboard.busy)
      process.stdout.write(
        "Finishing the current dashboard command before shutdown…\n",
      );
    void dashboard.close().finally(() => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      finish();
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (options.open) {
    try {
      await openWebBrowser(dashboard.url);
    } catch {
      process.stdout.write(
        `Could not open a browser. Open ${dashboard.url} on this machine.\n`,
      );
    }
  }
  await done;
}
