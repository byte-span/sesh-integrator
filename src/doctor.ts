import { constants } from "node:fs";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLegacyFindings } from "./audit.js";
import { inspectGit, refCommit } from "./git.js";
import { targetBranch, targetBranchSource } from "./promotion.js";
import { pullRequestPromotion } from "./pull-request.js";
import { run } from "./process.js";
import { applyGlobalTargetPolicy, runtimePaths } from "./runtime.js";
import type { Config, RepositoryConfig } from "./types.js";
import { isValidationStepList } from "./validation.js";

type CheckState = "PASS" | "SKIP" | "WARN" | "FAIL";

interface Check {
  state: CheckState;
  label: string;
  detail: string;
}

export async function doctorCommand(cwd = process.cwd()): Promise<void> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 20
      ? pass("Node.js", process.version)
      : fail("Node.js", `${process.version}; version 20 or newer is required`),
  );
  checks.push(await executableCheck("Git", "git", ["--version"]));

  const paths = runtimePaths();
  const requiredPaths = [
    paths.config,
    paths.state,
    paths.codexHome,
    paths.sessions,
    paths.locks,
    paths.logs,
    paths.worktrees,
  ];
  const missingPaths: string[] = [];
  for (const path of requiredPaths) {
    if (!(await exists(path))) missingPaths.push(path);
  }
  checks.push(
    missingPaths.length === 0
      ? pass("Runtime", paths.root)
      : fail(
          "Runtime",
          `missing ${missingPaths.join(", ")}; run codex-handoff init`,
        ),
  );
  let config: Config | undefined;
  try {
    config = JSON.parse(await readFile(paths.config, "utf8")) as Config;
    for (const repository of config.repositories ?? []) {
      repository.setupCommands ??= [];
      repository.validationTiers ??= [];
      repository.postIntegrationCommands ??= [];
    }
    validateConfig(config);
    for (const repository of config.repositories) {
      applyGlobalTargetPolicy(config, repository);
    }
    checks.push(pass("Configuration", paths.config));
  } catch (error) {
    checks.push(fail("Configuration", errorMessage(error)));
  }

  if (config?.conflictResolutionMode === "nested-codex") {
    try {
      await access(paths.codexHome, constants.W_OK);
      checks.push(pass("Resolver state", `${paths.codexHome} is writable`));
    } catch {
      checks.push(
        fail("Resolver state", `${paths.codexHome} must be writable by Codex`),
      );
    }
    checks.push(
      await executableCheck("Codex CLI", config.codexCommand, ["--version"]),
    );
  }

  const home = process.env.CODEX_HANDOFF_DOCTOR_HOME ?? homedir();
  const skillRoot = join(home, ".agents", "skills", "codex-handoff-workflow");
  const skillFiles = [
    join(skillRoot, "SKILL.md"),
    join(skillRoot, "agents", "openai.yaml"),
  ];
  const bundledSkillRoot = fileURLToPath(
    new URL("../skill/codex-handoff-workflow", import.meta.url),
  );
  const bundledSkillFiles = [
    join(bundledSkillRoot, "SKILL.md"),
    join(bundledSkillRoot, "agents", "openai.yaml"),
  ];
  if (!(await allExist(skillFiles))) {
    checks.push(
      fail(
        "Workflow skill",
        `missing installation at ${skillRoot}; run scripts/install-skill.sh`,
      ),
    );
  } else if (
    (await allExist(bundledSkillFiles)) &&
    !(await filesMatch(skillFiles, bundledSkillFiles))
  ) {
    checks.push(
      fail(
        "Workflow skill",
        `installed files differ from this CLI; run scripts/install-skill.sh`,
      ),
    );
  } else {
    checks.push(pass("Workflow skill", skillRoot));
  }

  const agentsPath = join(home, ".codex", "AGENTS.md");
  const bundledGuidancePath = fileURLToPath(
    new URL("../GLOBAL_AGENTS_SNIPPET.md", import.meta.url),
  );
  try {
    const [guidance, bundledGuidance] = await Promise.all([
      readFile(agentsPath, "utf8"),
      readFile(bundledGuidancePath, "utf8"),
    ]);
    const normalizedGuidance = normalizeText(guidance);
    const normalizedBundledGuidance = normalizeText(bundledGuidance);
    const conflictingBranchRule =
      /do not begin[^.\n]{0,160}(?:default branch|detached)/i.test(
        normalizedGuidance,
      );
    checks.push(
      conflictingBranchRule
        ? fail(
            "Global guidance",
            `${agentsPath} contains a stale detached/default-branch prohibition; synchronize it with ${bundledGuidancePath}`,
          )
        : normalizedGuidance.includes(normalizedBundledGuidance)
          ? pass("Global guidance", agentsPath)
          : fail(
              "Global guidance",
              `${agentsPath} differs from the bundled policy; synchronize it with ${bundledGuidancePath}`,
            ),
    );
  } catch (error) {
    checks.push(fail("Global guidance", errorMessage(error)));
  }

  if (config) checks.push(...(await repositoryChecks(config, cwd)));
  checks.push(await lockCheck(paths.locks));
  checks.push(...legacyChecks(await collectLegacyFindings()));

  process.stdout.write("codex-handoff doctor (read-only)\n\n");
  for (const check of checks) {
    process.stdout.write(
      `${check.state.padEnd(5)} ${check.label}: ${check.detail}\n`,
    );
  }

  const failures = checks.filter((check) => check.state === "FAIL").length;
  const warnings = checks.filter((check) => check.state === "WARN").length;
  process.stdout.write(
    failures === 0
      ? `\nREADY${warnings ? ` WITH ${warnings} WARNING${warnings === 1 ? "" : "S"}` : ""}\n`
      : `\nNOT READY (${failures} failure${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

async function repositoryChecks(config: Config, cwd: string): Promise<Check[]> {
  if (await isSelfHostingRepository(cwd)) {
    return [
      skip(
        "Current repository",
        "codex-handoff is intentionally self-managed and excluded from registration",
      ),
    ];
  }
  if (config.repositories.length === 0) {
    return [
      fail(
        "Repositories",
        "none registered; run codex-handoff register from a project",
      ),
    ];
  }

  let currentCommonDir: string | undefined;
  try {
    currentCommonDir = await realpath((await inspectGit(cwd)).gitCommonDir);
  } catch {
    // Outside a Git worktree, check every configured repository.
  }
  const repositories = currentCommonDir
    ? config.repositories.filter(
        (repository) => repository.gitCommonDir === currentCommonDir,
      )
    : config.repositories;
  if (currentCommonDir && repositories.length === 0) {
    return [
      fail("Current repository", "not registered; run codex-handoff register"),
    ];
  }

  const checks: Check[] = [];
  for (const repository of repositories) {
    checks.push(await repositoryCheck(repository));
    checks.push(await branchDestinationCheck(repository));
    const remotePromotion = pullRequestPromotion(repository);
    if (remotePromotion) {
      checks.push(await pullRequestPromotionCheck(repository));
    }
    checks.push(
      repository.setupCommands.length > 0
        ? pass(
            `Worktree setup (${repository.path})`,
            `${repository.setupCommands.length} command(s)`,
          )
        : warn(
            `Worktree setup (${repository.path})`,
            "no commands configured; registration found no setup requirement",
          ),
    );
    checks.push(
      repository.sourceValidationCommands.length > 0
        ? pass(
            `Source validation (${repository.path})`,
            `${repository.sourceValidationCommands.length} command(s)`,
          )
        : fail(
            `Source validation (${repository.path})`,
            "no commands configured",
          ),
    );
    checks.push(
      repository.integrationValidationCommands.length > 0
        ? pass(
            `Integration validation (${repository.path})`,
            `${repository.integrationValidationCommands.length} command(s)`,
          )
        : fail(
            `Integration validation (${repository.path})`,
            "no commands configured",
          ),
    );
    checks.push(
      (repository.validationTiers ?? []).length > 0
        ? pass(
            `Validation tiers (${repository.path})`,
            `${repository.validationTiers!.length} tier(s)`,
          )
        : warn(
            `Validation tiers (${repository.path})`,
            "none configured; all changes use full validation",
          ),
    );
  }
  return checks;
}

async function isSelfHostingRepository(cwd: string): Promise<boolean> {
  try {
    const toolRoot = fileURLToPath(new URL("..", import.meta.url));
    const [current, self] = await Promise.all([
      realpath((await inspectGit(cwd)).gitCommonDir),
      realpath((await inspectGit(toolRoot)).gitCommonDir),
    ]);
    return current === self;
  } catch {
    return false;
  }
}

async function pullRequestPromotionCheck(
  repository: RepositoryConfig,
): Promise<Check> {
  const promotion = pullRequestPromotion(repository)!;
  const head =
    promotion.mode === "session-branch"
      ? "<per-session source branch>"
      : targetBranch(repository);
  for (const branch of [
    promotion.productionBranch,
    ...(promotion.mode === "shared-target" ? [head] : []),
  ]) {
    const valid = await run("git", ["check-ref-format", "--branch", branch], {
      cwd: repository.path,
    });
    if (valid.code !== 0) {
      return fail(
        `Pull-request promotion (${repository.path})`,
        `invalid branch name ${branch}`,
      );
    }
  }
  const remote = await run("git", ["remote", "get-url", promotion.remote], {
    cwd: repository.path,
  });
  if (remote.code !== 0) {
    return fail(
      `Pull-request promotion (${repository.path})`,
      `remote ${promotion.remote} is not configured`,
    );
  }
  const auth = await run("gh", ["auth", "status"], { cwd: repository.path });
  if (auth.code !== 0) {
    return fail(
      `Pull-request promotion (${repository.path})`,
      "GitHub CLI authentication is unavailable; run gh auth login",
    );
  }
  return pass(
    `Pull-request promotion (${repository.path})`,
    `${promotion.mode}; ${head} -> ${promotion.productionBranch} via ${promotion.remote}`,
  );
}

async function branchDestinationCheck(
  repository: RepositoryConfig,
): Promise<Check> {
  const target = targetBranch(repository);
  if (target === repository.integrationBranch) {
    if (repository.targetBranch === undefined) {
      return fail(
        `Branch destinations (${repository.path})`,
        `ambiguous historical configuration: integrationBranch equals defaultBranch (${target}) while targetBranch is omitted`,
      );
    }
    return warn(
      `Branch destinations (${repository.path})`,
      `integrationBranch and targetBranch both resolve to ${target}; this explicit legacy-style opt-in has no separate final promotion ref`,
    );
  }
  const [targetHead, stagingHead] = await Promise.all([
    refCommit(repository.path, `refs/heads/${target}`),
    refCommit(repository.path, `refs/heads/${repository.integrationBranch}`),
  ]);
  if (!targetHead) {
    return fail(
      `Branch destinations (${repository.path})`,
      `target branch ${target} does not exist`,
    );
  }
  if (!stagingHead || stagingHead === targetHead) {
    return pass(
      `Branch destinations (${repository.path})`,
      `staging ${repository.integrationBranch}; target ${target} (${targetBranchSource(repository)})`,
    );
  }
  const [stagingBehind, targetBehind] = await Promise.all([
    run("git", ["merge-base", "--is-ancestor", stagingHead, targetHead], {
      cwd: repository.path,
    }),
    run("git", ["merge-base", "--is-ancestor", targetHead, stagingHead], {
      cwd: repository.path,
    }),
  ]);
  if (stagingBehind.code === 0) {
    return pass(
      `Branch destinations (${repository.path})`,
      `staging ${repository.integrationBranch} can fast-forward to target ${target}`,
    );
  }
  if (targetBehind.code === 0) {
    return warn(
      `Branch destinations (${repository.path})`,
      `staging ${repository.integrationBranch} is ahead of target ${target}; run codex-handoff reconcile`,
    );
  }
  return fail(
    `Branch destinations (${repository.path})`,
    `staging ${repository.integrationBranch} and target ${target} have diverged; manual review required`,
  );
}

async function repositoryCheck(repository: RepositoryConfig): Promise<Check> {
  try {
    const context = await inspectGit(repository.path);
    const actual = await realpath(context.gitCommonDir);
    const configured = await realpath(repository.gitCommonDir);
    return actual === configured
      ? pass("Registered repository", repository.path)
      : fail(
          "Registered repository",
          `${repository.path} Git directory does not match configuration`,
        );
  } catch (error) {
    return fail("Registered repository", errorMessage(error));
  }
}

async function lockCheck(path: string): Promise<Check> {
  try {
    const locks = (await readdir(path)).filter((name) =>
      name.endsWith(".lock"),
    );
    return locks.length === 0
      ? pass("Integration locks", "none")
      : warn(
          "Integration locks",
          `${locks.length} active; run codex-handoff status`,
        );
  } catch (error) {
    return fail("Integration locks", errorMessage(error));
  }
}

function legacyChecks(
  findings: Awaited<ReturnType<typeof collectLegacyFindings>>,
): Check[] {
  const conflicts = findings.filter(
    (finding) =>
      finding.state === "FOUND" &&
      (finding.label === "Old global skill" ||
        finding.label === "Legacy LaunchAgent plist" ||
        finding.label === "Loaded legacy launchctl job" ||
        finding.label.startsWith("Legacy Git hooks")),
  );
  const uncertain = findings.filter(
    (finding) =>
      finding.state === "UNKNOWN" &&
      (finding.label === "Legacy LaunchAgent plist" ||
        finding.label === "Loaded legacy launchctl job" ||
        finding.label.startsWith("Legacy Git hooks")),
  );
  if (conflicts.length > 0) {
    return [
      fail(
        "Legacy automation",
        `${conflicts.map((finding) => finding.label).join(", ")}; run codex-handoff audit-legacy`,
      ),
    ];
  }
  if (uncertain.length > 0) {
    return [
      warn(
        "Legacy automation",
        `could not verify ${uncertain.map((finding) => finding.label).join(", ")}; run codex-handoff audit-legacy`,
      ),
    ];
  }
  return [pass("Legacy automation", "no active legacy trigger found")];
}

async function executableCheck(
  label: string,
  command: string,
  args: string[],
): Promise<Check> {
  try {
    const result = await run(command, args);
    const detail = (result.stdout || result.stderr).trim().split("\n")[0];
    return result.code === 0
      ? pass(label, detail || command)
      : fail(label, `${command} exited ${result.code}`);
  } catch (error) {
    return fail(label, `${command}: ${errorMessage(error)}`);
  }
}

function validateConfig(config: Config): void {
  if (
    !config ||
    typeof config.lockWaitSeconds !== "number" ||
    typeof config.codexCommand !== "string" ||
    config.codexCommand.length === 0 ||
    !Array.isArray(config.repositories)
  ) {
    throw new Error("invalid config.json structure");
  }
  if (
    config.defaultTargetBranch !== undefined &&
    (typeof config.defaultTargetBranch !== "string" ||
      config.defaultTargetBranch.length === 0)
  ) {
    throw new Error("invalid defaultTargetBranch");
  }
  if (!validDefaultPromotionConfig(config.defaultPromotion)) {
    throw new Error("invalid defaultPromotion");
  }
  if (
    config.conflictResolutionMode !== undefined &&
    config.conflictResolutionMode !== "current-session" &&
    config.conflictResolutionMode !== "nested-codex"
  ) {
    throw new Error("invalid conflictResolutionMode");
  }
  for (const repository of config.repositories) {
    if (
      typeof repository.path !== "string" ||
      typeof repository.gitCommonDir !== "string" ||
      typeof repository.defaultBranch !== "string" ||
      repository.defaultBranch.length === 0 ||
      typeof repository.integrationBranch !== "string" ||
      repository.integrationBranch.length === 0 ||
      (repository.targetBranch !== undefined &&
        (typeof repository.targetBranch !== "string" ||
          repository.targetBranch.length === 0)) ||
      (repository.promotion !== undefined &&
        !validPromotionConfig(repository.promotion)) ||
      !Array.isArray(repository.setupCommands) ||
      (repository.setupCommandPolicy !== undefined &&
        repository.setupCommandPolicy !== "advisory" &&
        repository.setupCommandPolicy !== "required") ||
      !isValidationStepList(repository.sourceValidationCommands) ||
      !isValidationStepList(repository.integrationValidationCommands) ||
      (repository.validationCache !== undefined &&
        repository.validationCache !== "off" &&
        repository.validationCache !== "session" &&
        repository.validationCache !== "repository") ||
      (repository.validationTiers !== undefined &&
        (!Array.isArray(repository.validationTiers) ||
          repository.validationTiers.some(
            (tier) =>
              typeof tier.name !== "string" ||
              !Array.isArray(tier.paths) ||
              !isValidationStepList(tier.sourceValidationCommands) ||
              !isValidationStepList(tier.integrationValidationCommands),
          )))
    ) {
      throw new Error("invalid repository entry in config.json");
    }
    if (
      repository.targetBranch === undefined &&
      (repository.integrationBranch === repository.defaultBranch ||
        repository.integrationBranch ===
          (config.defaultTargetBranch ?? repository.defaultBranch))
    ) {
      throw new Error(
        `ambiguous repository entry: integrationBranch ${repository.integrationBranch} equals the default or effective target while targetBranch is omitted`,
      );
    }
    if (
      repository.promotion?.type === "pull-request" &&
      repository.promotion.mode !== "session-branch" &&
      (repository.promotion.productionBranch ?? repository.defaultBranch) ===
        (repository.targetBranch ??
          config.defaultTargetBranch ??
          repository.defaultBranch)
    ) {
      throw new Error(
        "pull-request promotion target and production branches must differ",
      );
    }
  }
}

function validPromotionConfig(
  promotion: RepositoryConfig["promotion"],
): boolean {
  if (!promotion || promotion.type === "none") return true;
  return (
    promotion.type === "pull-request" &&
    (promotion.mode === undefined ||
      promotion.mode === "shared-target" ||
      promotion.mode === "session-branch") &&
    (promotion.productionBranch === undefined ||
      (typeof promotion.productionBranch === "string" &&
        promotion.productionBranch.length > 0)) &&
    (promotion.remote === undefined ||
      (typeof promotion.remote === "string" && promotion.remote.length > 0)) &&
    validParticipantList(promotion.reviewers) &&
    validParticipantList(promotion.assignees)
  );
}

function validDefaultPromotionConfig(
  promotion: Config["defaultPromotion"],
): boolean {
  return (
    promotion === undefined ||
    (typeof promotion === "object" &&
      promotion !== null &&
      validParticipantList(promotion.reviewers) &&
      validParticipantList(promotion.assignees))
  );
}

function validParticipantList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((name) => typeof name === "string" && name.length > 0))
  );
}

async function allExist(paths: string[]): Promise<boolean> {
  return (await Promise.all(paths.map(exists))).every(Boolean);
}

async function filesMatch(
  installed: string[],
  bundled: string[],
): Promise<boolean> {
  const [installedContents, bundledContents] = await Promise.all([
    Promise.all(installed.map((path) => readFile(path, "utf8"))),
    Promise.all(bundled.map((path) => readFile(path, "utf8"))),
  ]);
  return installedContents.every(
    (contents, index) => contents === bundledContents[index],
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pass(label: string, detail: string): Check {
  return { state: "PASS", label, detail };
}

function skip(label: string, detail: string): Check {
  return { state: "SKIP", label, detail };
}

function warn(label: string, detail: string): Check {
  return { state: "WARN", label, detail };
}

function fail(label: string, detail: string): Check {
  return { state: "FAIL", label, detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}
