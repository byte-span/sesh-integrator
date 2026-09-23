import { worktreePaths } from "./worktree-location.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { repositoryCommonDir, isRepositoryDisabled } from "./enablement.js";
import {
  runtimePaths,
  readConfig,
  writeJsonAtomic,
  withConfigLock,
} from "./runtime.js";
import { run } from "./process.js";

export class CapabilityBlockedError extends Error {}

export interface CapabilityFailure {
  operation: string;
  location: string;
  evidence: string;
}
export interface CapabilityReport {
  version: 1;
  context: string;
  scope: string;
  checkedAt: string;
  skipped?: string;
  failures: CapabilityFailure[];
  artifacts: string[];
}

// Hash only selected context signals; never serialize the environment or credentials.
// No portable API identifies every sandbox policy. Success is deliberately not cached.
export function executionContext(env = process.env): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        hostname(),
        process.platform,
        process.arch,
        process.getuid?.(),
        process.execPath,
        ...[
          "CODEX_SANDBOX",
          "CODEX_SANDBOX_NETWORK_DISABLED",
          "SANDBOX_CONTAINER_ID",
          "SESH_EXECUTION_CONTEXT",
          "PATH",
        ].map((key) => env[key] ?? ""),
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

function evidence(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  const code = e?.code;
  if (code === "EPERM" || code === "EACCES")
    return `${code}: access denied; filesystem permissions, ACLs, sandbox or host policy are possible causes, not established diagnoses`;
  if (code === "EROFS")
    return "EROFS: filesystem reported a read-only location";
  if (code === "ENOENT")
    return "ENOENT: required path or executable was not found";
  return error instanceof Error ? error.message : String(error);
}

async function readOptional<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

async function scopeFor(cwd: string): Promise<string> {
  // Outside Git, setup still checks the runtime. Git failures in a repository
  // are diagnosed by the probe rather than silently treated as readiness.
  const result = await run("git", ["rev-parse", "--git-common-dir"], { cwd });
  if (result.code === 0) return repositoryCommonDir(cwd);
  if (result.stderr.includes("not a git repository")) return resolve(cwd);
  throw new Error(
    `Git repository discovery at ${cwd}: ${result.stderr.trim()}`,
  );
}

function recordPaths(scope: string, context: string) {
  const key = createHash("sha256")
    .update(scope + "\0" + context)
    .digest("hex");
  const root = join(runtimePaths().root, "capabilities");
  return {
    root,
    choice: join(root, key + ".choice.json"),
    report: join(root, key + ".report.json"),
  };
}

async function nearestDirectory(path: string): Promise<string> {
  for (;;) {
    try {
      if ((await fs.stat(path)).isDirectory()) return path;
      throw new Error(`Not a directory: ${path}`);
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(path) === path
      )
        throw e;
      path = dirname(path);
    }
  }
}

export async function probeCapabilities(
  cwd: string,
  additionalLocations: string[] = [],
): Promise<CapabilityReport> {
  const report: CapabilityReport = {
    version: 1,
    context: executionContext(),
    scope: resolve(cwd),
    checkedAt: new Date().toISOString(),
    failures: [],
    artifacts: [],
  };
  const attempt = async (
    operation: string,
    location: string,
    action: () => Promise<unknown>,
  ) => {
    try {
      await action();
      return true;
    } catch (error) {
      report.failures.push({ operation, location, evidence: evidence(error) });
      return false;
    }
  };
  let common: string | undefined;
  await attempt("discover Git repository", cwd, async () => {
    report.scope = await scopeFor(cwd);
  });
  if (report.failures.length) return report;
  if (isRepositoryDisabled(await readConfig(true), report.scope)) {
    report.skipped = "Repository disabled; capability probes skipped";
    return report;
  }
  // Discovery above distinguishes non-repositories from Git safety/ownership failures.
  const discovery = await run("git", ["rev-parse", "--git-common-dir"], {
    cwd,
  });
  if (discovery.code === 0) common = report.scope;
  const paths = await worktreePaths(cwd);
  const destinations = [
    paths.sourceWorktrees,
    paths.worktrees,
    paths.recoveryWorktrees,
  ];
  for (const destination of destinations)
    await attempt("prepare worktree directory", destination, () =>
      fs.mkdir(destination, { recursive: true }),
    );
  const locations = [
    paths.root,
    join(paths.root, "coordinators"),
    paths.sessions,
    paths.locks,
    paths.sourceWorktrees,
    paths.worktrees,
    paths.recoveryWorktrees,
    paths.recoveryBundles,
    ...(common ? [common, join(common, "worktrees"), cwd] : []),
    ...additionalLocations,
  ];
  if (common) {
    await attempt("locate worktree Git metadata", cwd, async () => {
      const result = await run("git", ["rev-parse", "--absolute-git-dir"], {
        cwd,
      });
      if (result.code) throw new Error(result.stderr.trim());
      locations.push(result.stdout.trim());
    });
  }
  const parents = new Set<string>();
  for (const location of locations) {
    await attempt("locate writable probe parent", location, async () => {
      parents.add(await nearestDirectory(location));
    });
  }
  for (const parent of parents) {
    let root: string | undefined;
    if (
      !(await attempt("create disposable directory", parent, async () => {
        root = await fs.mkdtemp(join(parent, ".sesh-capability-"));
      }))
    )
      continue;
    const original = root!;
    let active = original;
    try {
      const file = join(active, "file");
      const renamed = join(active, "renamed");
      if (
        await attempt("exclusive file create/write", file, () =>
          fs.writeFile(file, "probe\n", { flag: "wx", mode: 0o600 }),
        )
      ) {
        if (await attempt("rename file", file, () => fs.rename(file, renamed)))
          await attempt("unlink file", renamed, () => fs.unlink(renamed));
      }
      const destination = original + "-renamed";
      await attempt("rename directory", original, async () => {
        await fs.rename(original, destination);
        active = destination;
      });
      const child = join(active, "nested");
      if (
        await attempt("create nested directory", child, () => fs.mkdir(child))
      )
        await attempt("remove directory", child, () => fs.rmdir(child));
    } finally {
      if (
        !(await attempt("cleanup disposable directory", active, () =>
          fs.rm(active, { recursive: true, force: true }),
        ))
      )
        report.artifacts.push(active);
    }
  }
  // Stop before Git probing if basic operations already failed: avoid predictable debris.
  if (report.failures.length) return report;
  const parent = await nearestDirectory(paths.worktrees);
  let root: string | undefined;
  if (
    !(await attempt("create disposable Git fixture", parent, async () => {
      root = await fs.mkdtemp(join(parent, ".sesh-git-capability-"));
    }))
  )
    return report;
  const fixture = root!;
  const repo = join(fixture, "repo");
  // Isolate only disposable Git operations. Real commits keep their signing policy.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  async function git(args: string[], directory: string) {
    const result = await run(
      "git",
      [
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=" + join(fixture, "no-hooks"),
        ...args,
      ],
      { cwd: directory, env, timeoutMs: 10000 },
    );
    if (result.code)
      throw new Error(result.stderr.trim() || `Git exit ${result.code}`);
  }
  try {
    if (
      (await attempt("git init (disposable repository)", repo, () =>
        git(["init", "--quiet", repo], fixture),
      )) &&
      (await attempt("git index write", repo, () =>
        git(["read-tree", "--empty"], repo),
      )) &&
      (await attempt("git commit/ref write (unsigned fixture only)", repo, () =>
        git(
          [
            "-c",
            "user.name=Capability Probe",
            "-c",
            "user.email=probe@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "probe",
          ],
          repo,
        ),
      ))
    ) {
      for (const destination of destinations) {
        let owned: string | undefined;
        if (
          !(await attempt(
            "create worktree probe parent",
            destination,
            async () => {
              owned = await fs.mkdtemp(
                join(destination, ".sesh-worktree-probe-"),
              );
            },
          ))
        )
          continue;
        const worktree = join(owned!, "tree");
        if (
          await attempt(
            "git worktree add (disposable repository)",
            worktree,
            () => git(["worktree", "add", "--detach", worktree, "HEAD"], repo),
          )
        )
          await attempt(
            "git worktree remove (owned disposable fixture)",
            worktree,
            () => git(["worktree", "remove", worktree], repo),
          );
        if (
          !(await attempt("cleanup owned worktree probe", owned!, () =>
            fs.rm(owned!, { recursive: true, force: true }),
          ))
        )
          report.artifacts.push(owned!);
      }
    }
  } finally {
    if (
      !(await attempt("cleanup disposable Git fixture", fixture, () =>
        fs.rm(fixture, { recursive: true, force: true }),
      ))
    )
      report.artifacts.push(fixture);
  }
  return report;
}

export function recoveryChoices(): string {
  return (
    "Recovery choices:\n" +
    "  1. Review the named path and operation with the host administrator; repair only the proven path/ACL/mount or execution policy. Preserve .env/secret restrictions. No blanket chmod, sandbox relaxation, or lock deletion is authorized. Recheck in the repaired context with seshx capabilities --recheck.\n" +
    "  2. Persist manual handoff here: seshx capabilities --mode manual. Inspect seshx status --session <id>; continue the same session from its recorded source checkout using its pinned coordinator in an authorized environment. Run capabilities --recheck there before retrying the original command (resume only for resumable sessions).\n" +
    "  Optional location: from the main checkout, select seshx worktree-location --repo-local (recommended .worktrees directory), or --directory <absolute-path>, then explicitly recheck in the intended agent environment. Git metadata and runtime writes must still be permitted; existing sessions are never moved.\n" +
    "  3. Opt this repository out: seshx disable. This preserves sessions and Git state; it also needs runtime write permission.\n" +
    "To restore automation in this context, run seshx capabilities --mode automatic, then --recheck. Configuration cannot grant host permissions."
  );
}

export function formatCapabilityReport(report: CapabilityReport): string {
  if (report.skipped) return `${report.skipped}: ${report.scope}\n`;
  return (
    `Execution capabilities: ${report.failures.length ? "BLOCKED" : "PASS"} (context ${report.context})\nScope: ${report.scope}\n` +
    report.failures
      .map((f) => `  ${f.operation} at ${f.location}: ${f.evidence}\n`)
      .join("") +
    (report.artifacts.length
      ? `Unremoved probe artifacts (inspect before manual removal):\n${report.artifacts.join("\n")}\n`
      : "") +
    "Installer-shell access does not establish agent-sandbox access. Recheck from the intended agent environment; registration and lifecycle commands check again.\n" +
    "Probes use disposable resources; user refs, index, worktrees and existing sessions are preserved. A pass is not a guarantee of later operations, signing, network or service access.\n" +
    (report.failures.length ? recoveryChoices() + "\n" : "")
  );
}

async function saveReport(report: CapabilityReport): Promise<void> {
  const paths = recordPaths(report.scope, report.context);
  try {
    const previous = await readOptional<CapabilityReport>(paths.report);
    for (const artifact of previous?.artifacts ?? []) {
      try {
        await fs.lstat(artifact);
        if (!report.artifacts.includes(artifact))
          report.artifacts.push(artifact);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !report.artifacts.includes(artifact)
        )
          report.artifacts.push(artifact);
      }
    }
    await fs.mkdir(paths.root, { recursive: true });
    await writeJsonAtomic(paths.report, report);
  } catch (e) {
    process.stderr.write(
      `Could not persist capability evidence at ${paths.report}: ${evidence(e)}. No choice was changed.\n`,
    );
  }
}

export async function capabilitiesCommand(
  args: string[],
  cwd = process.cwd(),
): Promise<CapabilityReport | undefined> {
  if (
    args.length &&
    !(args.length === 1 && args[0] === "--recheck") &&
    !(
      args.length === 2 &&
      args[0] === "--mode" &&
      ["manual", "automatic"].includes(args[1]!)
    )
  )
    throw new Error(
      "Usage: seshx capabilities [--recheck | --mode manual|automatic]",
    );
  if (args[0] === "--mode") {
    const scope = await scopeFor(cwd);
    const paths = recordPaths(scope, executionContext());
    await withConfigLock(async () => {
      await fs.mkdir(paths.root, { recursive: true });
      await writeJsonAtomic(paths.choice, { version: 1, mode: args[1] });
    });
    process.stdout.write(
      `Execution mode: ${args[1]} for ${scope} in context ${executionContext()}. Existing sessions and repository enablement preserved.\n${recoveryChoices()}\n`,
    );
    return;
  }
  const report = await probeCapabilities(cwd);
  await saveReport(report);
  const choice = await readOptional<{ mode: string }>(
    recordPaths(report.scope, report.context).choice,
  );
  process.stdout.write(
    `Execution mode: ${choice?.mode ?? "automatic"}\n${formatCapabilityReport(report)}`,
  );
  return report;
}

export async function requireCapabilities(
  cwd = process.cwd(),
  allowDisabled = false,
  additionalLocations: string[] = [],
): Promise<void> {
  const scope = await scopeFor(cwd);
  const config = await readConfig(true);
  if (isRepositoryDisabled(config, scope)) {
    if (allowDisabled) return;
    throw new Error(
      `Repository is disabled: ${scope}; capability probes skipped.`,
    );
  }
  const paths = recordPaths(scope, executionContext());
  const choice = await readOptional<{ version: number; mode: string }>(
    paths.choice,
  );
  if (
    choice &&
    (choice.version !== 1 || !["manual", "automatic"].includes(choice.mode))
  )
    throw new Error(
      `Invalid capability choice: ${paths.choice}; inspect before continuing`,
    );
  if (choice?.mode === "manual")
    throw new Error(
      `Manual handoff mode: automatic lifecycle operations stopped before session or Git mutation. Existing state preserved.\n${recoveryChoices()}`,
    );
  const previous = await readOptional<CapabilityReport>(paths.report);
  if (previous?.failures.length)
    throw new CapabilityBlockedError(
      `Previous capability failure retained; no probe repeated. Run seshx capabilities --recheck after environment repair.\n${formatCapabilityReport(previous)}`,
    );
  const report = await probeCapabilities(cwd, additionalLocations);
  if (report.failures.length) {
    await saveReport(report);
    throw new CapabilityBlockedError(formatCapabilityReport(report));
  }
}

/** Installer diagnostics do not clear stops or prevent installing the recovery CLI. */
export async function installationReadiness(
  cwd = process.cwd(),
): Promise<void> {
  const scope = await scopeFor(cwd);
  const paths = recordPaths(scope, executionContext());
  const choice = await readOptional<{ mode: string }>(paths.choice);
  const previous = await readOptional<CapabilityReport>(paths.report);
  if (choice?.mode === "manual") {
    process.stdout.write(
      "Manual handoff selected; automatic worktree readiness probes skipped. CLI installation may continue.\n",
    );
    return;
  }
  const report = previous?.failures.length
    ? previous
    : await probeCapabilities(cwd);
  process.stdout.write(formatCapabilityReport(report));
  if (report.failures.length)
    process.stdout.write(
      "Automatic integration is unavailable in this context; CLI installation may continue for configuration or manual handoff. Permissions were not changed.\n",
    );
}

/** Supplement late failures without replacing the primary exception or touching recovery state. */
export async function reportExecutionFailure(
  error: unknown,
  operation: string,
): Promise<void> {
  if (error instanceof CapabilityBlockedError) return;
  const failures: CapabilityFailure[] = [];
  const visit = (value: unknown) => {
    if (!(value instanceof Error)) return;
    const e = value as NodeJS.ErrnoException;
    if (
      ["EPERM", "EACCES", "EROFS"].includes(e.code ?? "") ||
      /permission denied|operation not permitted|read-only file system|dubious ownership/i.test(
        e.message,
      ) ||
      (e.code === "ENOENT" && e.syscall?.startsWith("spawn"))
    )
      failures.push({
        operation: e.syscall ?? operation,
        location: e.path ?? process.cwd(),
        evidence: evidence(e),
      });
    if (value instanceof AggregateError) value.errors.forEach(visit);
    else if (value.cause) visit(value.cause);
  };
  visit(error);
  if (!failures.length) return;
  try {
    const scope = await scopeFor(process.cwd()).catch(() =>
      resolve(process.cwd()),
    );
    const report: CapabilityReport = {
      version: 1,
      scope,
      context: executionContext(),
      checkedAt: new Date().toISOString(),
      failures,
      artifacts: [],
    };
    await saveReport(report);
    process.stderr.write(
      "Execution operation failed after preflight. State may already have advanced; inspect seshx status and the original error's preserved paths before retrying. Existing recovery records have not been removed.\n" +
        recoveryChoices() +
        "\n",
    );
  } catch (diagnosticError) {
    process.stderr.write(
      `Could not record execution diagnosis: ${evidence(diagnosticError)}; original error retained.\n`,
    );
  }
}
