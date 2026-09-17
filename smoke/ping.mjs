import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { harnessInfo } from "../scripts/harness-metadata.mjs";

const names = Object.keys(harnessInfo);
const prompt = "Reply exactly OK";
const root = fileURLToPath(new URL("../", import.meta.url));
const help = `Usage: pnpm test:ping:live --harness claude,gemini,grok | --installed
One short live prompt per harness, using existing login; normal account charges apply.
--installed selects executable configured commands on PATH, not authenticated accounts.
30-second timeout per harness; no automatic retries. Provider output is suppressed.
`;

export function selection(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      harness: { type: "string", multiple: true },
      installed: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return { help: true };
  if (values.installed && values.harness)
    throw new Error("Choose --harness or --installed.");
  if (values.installed) return { installed: true };
  const selected = (values.harness ?? []).flatMap((s) =>
    s.split(",").map((n) => n.trim()),
  );
  if (
    !selected.length ||
    selected.some((n) => !names.includes(n)) ||
    new Set(selected).size !== selected.length
  )
    throw new Error(
      `Select unique names with --harness ${names.join(",")} or --installed.`,
    );
  return { harnesses: selected };
}

export async function executable(command, env = process.env) {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [resolve(command)]
      : (env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((p) => resolve(p, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* Try next PATH entry. */
    }
  }
  return undefined;
}

export async function invocation(harness, cwd, environment) {
  const env = { ...environment };
  switch (harness) {
    case "claude":
      // Bare mode bypasses OAuth; safe mode preserves normal login.
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "16";
      return {
        env,
        args: [
          "-p",
          prompt,
          "--safe-mode",
          "--output-format",
          "json",
          "--tools",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--no-session-persistence",
          "--max-turns",
          "1",
          "--system-prompt",
          "Reply exactly OK.",
        ],
      };
    case "gemini": {
      const policy = join(cwd, "deny.toml");
      const system = join(cwd, "system.md");
      await writeFile(system, "Reply exactly OK. Do not call tools.", {
        mode: 0o600,
      });
      env.GEMINI_SYSTEM_MD = system;
      await mkdir(join(cwd, ".gemini"));
      await writeFile(
        join(cwd, ".gemini", "settings.json"),
        JSON.stringify({
          model: { maxSessionTurns: 1 },
          tools: { core: [] },
          hooksConfig: { enabled: false },
          context: { fileName: [], includeDirectories: [] },
          mcp: { allowed: [] },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        policy,
        '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n',
        { mode: 0o600 },
      );
      return {
        env,
        args: [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--policy",
          policy,
          "--extensions",
          "none",
          "--allowed-mcp-server-names",
          "",
        ],
      };
    }
    case "grok":
      return {
        env,
        args: [
          "--no-auto-update",
          "-p",
          prompt,
          "--output-format",
          "json",
          "--tools",
          "",
          "--deny",
          "MCPTool",
          "--no-subagents",
          "--no-memory",
          "--no-plan",
          "--disable-web-search",
          "--max-turns",
          "1",
          "--system-prompt-override",
          "Reply exactly OK.",
        ],
      };
    case "codex": {
      const system = join(cwd, "system.md");
      await writeFile(system, "Reply exactly OK. Do not call tools.", {
        mode: 0o600,
      });
      return {
        env,
        args: [
          "exec",
          "--ignore-user-config",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--json",
          "-c",
          'web_search="disabled"',
          "-c",
          "project_doc_max_bytes=0",
          "-c",
          `model_instructions_file=${JSON.stringify(system)}`,
          "-c",
          'developer_instructions=""',
          "-c",
          "include_apps_instructions=false",
          "-c",
          "include_collaboration_mode_instructions=false",
          ...[
            "shell_tool",
            "apps",
            "multi_agent",
            "view_image",
            "browser_use",
            "computer_use",
            "js_repl",
            "code_mode",
            "sleep_tool",
          ].flatMap((f) => ["--disable", f]),
          prompt,
        ],
      };
    }
    default:
      throw new Error("Unknown harness.");
  }
}

export function classifyFailure(text) {
  if (
    /unknown (option|argument)|unrecognized (option|argument)|unexpected argument|invalid (option|argument)/i.test(
      text,
    )
  )
    return "unsupported CLI options";
  if (
    /not logged in|authentication|unauthenticated|invalid.api.key|login required|please.*login|401|credential|auth method|GEMINI_API_KEY/i.test(
      text,
    )
  )
    return "authentication failed (check login)";
  if (/quota|rate.limit|429|credit.balance/i.test(text))
    return "quota or rate limit";
  if (/ECONN|ENOTFOUND|fetch failed|network error/i.test(text))
    return "connection failed";
  return "CLI error (check login/configuration)";
}

// Bounded subprocess with capped in-memory output; never echo provider errors.
export function execute(command, args, { cwd, env, timeoutMs = 30_000 }) {
  return new Promise((done) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      env,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      settled = false;
    const finish = (status, code = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ status, code, stdout });
    };
    const stop = (status) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
      finish(status);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) stop("output limit");
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (bytes < 1_048_576) stderr += chunk.toString();
      bytes += chunk.length;
      if (bytes > 1_048_576) stop("output limit");
    });
    child.once("error", () => finish("could not start"));
    child.once("close", (code) =>
      finish(code === 0 ? "ok" : classifyFailure(stdout + "\n" + stderr), code),
    );
  });
}

export function validResponse(harness, stdout) {
  try {
    if (harness === "codex") {
      const events = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return (
        !events.some((e) => ["error", "turn.failed"].includes(e.type)) &&
        events.some((e) => e.type === "turn.completed") &&
        events
          .filter(
            (e) =>
              e.type === "item.completed" && e.item?.type === "agent_message",
          )
          .at(-1)
          ?.item.text?.trim() === "OK"
      );
    }
    const e = JSON.parse(stdout);
    return (
      !!e &&
      !e.error &&
      !e.is_error &&
      e.type !== "error" &&
      !String(e.subtype).startsWith("error") &&
      (harness === "claude"
        ? e.result
        : harness === "gemini"
          ? e.response
          : e.text
      )?.trim() === "OK"
    );
  } catch {
    return false;
  }
}

export async function ping(harness, command, config = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "sesh-ping-"));
  const started = Date.now();
  try {
    const call = await invocation(harness, cwd, config.env ?? process.env);
    const result = await execute(command, call.args, {
      cwd,
      env: call.env,
      timeoutMs: config.timeoutMs,
    });
    const passed =
      result.status === "ok" && validResponse(harness, result.stdout);
    const { normalizeUsage } = await import("../dist/usage-normalization.js");
    const rows = normalizeUsage(harness, result.stdout, !passed);
    const known = rows.every((r) => r.total !== null);
    const tokens = known
      ? `${rows.reduce((s, r) => s + r.total, 0)}${rows.some((r) => r.coverage !== "reported") ? " (partial)" : ""}`
      : "unknown";
    return {
      passed,
      line: `${harness}: ${passed ? "PASS" : "FAIL"} (${Date.now() - started}ms; tokens: ${tokens})${passed ? "" : ` — ${result.status === "ok" ? "unexpected response" : result.status}`}`,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function runSelected(
  selected,
  config,
  env = process.env,
  report = console.log,
) {
  const command = (h) =>
    config.harnessCommands?.[h] ??
    (h === "codex" ? config.codexCommand : undefined) ??
    h;
  const harnesses = selected.installed ? names : selected.harnesses;
  let count = 0,
    failed = false;
  for (const h of harnesses) {
    const path = await executable(command(h), env);
    if (!path && selected.installed) continue;
    count++;
    if (!path) {
      report(`${h}: FAIL (executable unavailable)`);
      failed = true;
      continue;
    }
    const result = await ping(h, path, { env });
    report(result.line);
    failed ||= !result.passed;
  }
  if (!count) {
    report("No installed harness executables found.");
    return 1;
  }
  return failed ? 1 : 0;
}

export async function main(args) {
  const selected = selection(args);
  if (selected.help) {
    console.log(help);
    return 0;
  }
  const require = createRequire(import.meta.url);
  const build = spawnSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    { cwd: root, stdio: "inherit" },
  );
  if (build.status !== 0) return 1;
  const { readConfig } = await import("../dist/runtime.js");
  return runSelected(selected, await readConfig(true));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    console.error(
      "Ping failed; check arguments (--help), installation, and seshx configuration. Provider output suppressed.",
    );
    process.exitCode = 1;
  }
}
