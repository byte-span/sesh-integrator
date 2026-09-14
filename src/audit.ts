import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import { run } from "./process.js";
import { runtimePaths } from "./runtime.js";
import type { Config } from "./types.js";

export type FindingState = "FOUND" | "NOT FOUND" | "UNKNOWN";

export interface Finding {
  label: string;
  state: FindingState;
  detail: string;
}

export async function auditLegacyCommand(): Promise<Finding[]> {
  const findings = await collectLegacyFindings();
  for (const finding of findings) {
    process.stdout.write(
      `${finding.state.padEnd(9)} ${finding.label}: ${finding.detail}\n`,
    );
  }
  process.stdout.write(
    "\nRead-only audit complete. Disable legacy automation with the old project's documented stop/uninstall commands; " +
      "review the old skill, global AGENTS.md, and hooks individually. Nothing was changed.\n",
  );
  return findings;
}

export async function collectLegacyFindings(): Promise<Finding[]> {
  const home = process.env.PARALLEL_INTEGRATOR_AUDIT_HOME ?? homedir();
  const findings: Finding[] = [];
  const oldSource = join(home, "Developer", "tools", "codex-integrator");
  const oldState = join(home, ".codex-integrator");
  const oldSkill = join(home, ".agents", "skills", "codex-integrator-workflow");
  findings.push(
    await pathFinding(
      "Old source directory",
      oldSource,
      "Source alone is inert, but may contain daemon tooling.",
    ),
  );
  findings.push(
    await pathFinding(
      "Old runtime directory",
      oldState,
      "May contain daemon configuration, state, and logs.",
    ),
  );
  findings.push(
    await pathFinding(
      "Old global skill",
      oldSkill,
      "Can conflict if it triggers the legacy lifecycle.",
    ),
  );
  findings.push(
    await contentFinding(
      "Global AGENTS.md legacy reference",
      join(home, ".codex", "AGENTS.md"),
      /codex-integrator/i,
      "Legacy automatic instructions can trigger duplicate integration.",
    ),
  );
  findings.push(
    await contentFinding(
      "Codex config legacy reference",
      join(home, ".codex", "config.toml"),
      /codex-integrator/i,
      "Review whether the old skill is enabled or disabled.",
    ),
  );

  const launchAgents = join(home, "Library", "LaunchAgents");
  try {
    const names = (await readdir(launchAgents)).filter((name) =>
      /codex.*integrator|integrator.*codex/i.test(name),
    );
    findings.push({
      label: "Legacy LaunchAgent plist",
      state: names.length ? "FOUND" : "NOT FOUND",
      detail: names.length
        ? names.map((name) => join(launchAgents, name)).join(", ")
        : "No likely plist filename found.",
    });
  } catch (error) {
    findings.push({
      label: "Legacy LaunchAgent plist",
      state: "UNKNOWN",
      detail: errorMessage(error),
    });
  }

  try {
    const launchctl = await run("launchctl", ["list"]);
    if (launchctl.code !== 0)
      throw new Error(
        (launchctl.stderr || launchctl.stdout).trim() ||
          "launchctl list failed",
      );
    const matches = launchctl.stdout
      .split("\n")
      .filter((line) => /codex.*integrator|integrator.*codex/i.test(line));
    findings.push({
      label: "Loaded legacy launchctl job",
      state: matches.length ? "FOUND" : "NOT FOUND",
      detail: matches.length
        ? matches.join(" | ")
        : "No matching loaded job found.",
    });
  } catch (error) {
    findings.push({
      label: "Loaded legacy launchctl job",
      state: "UNKNOWN",
      detail: errorMessage(error),
    });
  }

  try {
    const config = JSON.parse(
      await readFile(runtimePaths().config, "utf8"),
    ) as Config;
    for (const repository of config.repositories) {
      findings.push(
        ...(await auditRepository(repository.path, repository.gitCommonDir)),
      );
    }
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    findings.push(
      code === "ENOENT"
        ? {
            label: "Registered repository audit",
            state: "NOT FOUND",
            detail: `No sesh-integrator config at ${
              runtimePaths().config
            }; no repositories to inspect.`,
          }
        : {
            label: "Registered repository audit",
            state: "UNKNOWN",
            detail: errorMessage(error),
          },
    );
  }

  return findings;
}

async function auditRepository(
  path: string,
  gitCommonDir: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  try {
    const hooksPath = await run("git", ["config", "--get", "core.hooksPath"], {
      cwd: path,
    });
    const locations = [join(gitCommonDir, "hooks")];
    if (hooksPath.code === 0 && hooksPath.stdout.trim()) {
      locations.push(join(path, hooksPath.stdout.trim()));
    }
    const matches: string[] = [];
    for (const location of locations) {
      try {
        for (const name of await readdir(location)) {
          const file = join(location, name);
          try {
            if (/codex-integrator/i.test(await readFile(file, "utf8")))
              matches.push(file);
          } catch {
            // Ignore directories and unreadable non-hook entries.
          }
        }
      } catch {
        // A missing hook directory means no hook findings there.
      }
    }
    findings.push({
      label: `Legacy Git hooks (${path})`,
      state: matches.length ? "FOUND" : "NOT FOUND",
      detail: matches.length
        ? matches.join(", ")
        : "No hook containing codex-integrator found.",
    });
  } catch (error) {
    findings.push({
      label: `Legacy Git hooks (${path})`,
      state: "UNKNOWN",
      detail: errorMessage(error),
    });
  }

  try {
    const oldBranch = await run(
      "git",
      ["show-ref", "--verify", "--quiet", "refs/heads/codex/integration"],
      { cwd: path },
    );
    const worktrees = await git(["worktree", "list", "--porcelain"], path);
    const oldWorktrees = worktrees
      .split("\n")
      .filter((line) => /codex-integrator|codex\/integration/i.test(line));
    const found = oldBranch.code === 0 || oldWorktrees.length > 0;
    findings.push({
      label: `Legacy integration branch/worktree (${path})`,
      state: found ? "FOUND" : "NOT FOUND",
      detail: found
        ? `branch=${
            oldBranch.code === 0 ? "present" : "absent"
          }; worktree references=${oldWorktrees.join(" | ") || "none"}`
        : "No codex/integration branch or likely legacy worktree found.",
    });
  } catch (error) {
    findings.push({
      label: `Legacy integration branch/worktree (${path})`,
      state: "UNKNOWN",
      detail: errorMessage(error),
    });
  }
  return findings;
}

async function pathFinding(
  label: string,
  path: string,
  foundDetail: string,
): Promise<Finding> {
  try {
    await access(path, constants.F_OK);
    return { label, state: "FOUND", detail: `${path}. ${foundDetail}` };
  } catch {
    return { label, state: "NOT FOUND", detail: path };
  }
}

async function contentFinding(
  label: string,
  path: string,
  pattern: RegExp,
  foundDetail: string,
): Promise<Finding> {
  try {
    const found = pattern.test(await readFile(path, "utf8"));
    return {
      label,
      state: found ? "FOUND" : "NOT FOUND",
      detail: found
        ? `${path}. ${foundDetail}`
        : `${path} has no legacy reference.`,
    };
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    return code === "ENOENT"
      ? { label, state: "NOT FOUND", detail: path }
      : { label, state: "UNKNOWN", detail: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
