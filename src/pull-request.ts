import { run } from "./process.js";
import { targetBranch } from "./promotion.js";
import type { RepositoryConfig, Session } from "./types.js";

export interface PullRequestPromotion {
  mode: "shared-target" | "session-branch";
  productionBranch: string;
  remote: string;
  reviewers: string[];
  assignees: string[];
}

export function pullRequestPromotion(
  repository: RepositoryConfig,
): PullRequestPromotion | undefined {
  if (!repository.promotion || repository.promotion.type === "none") {
    return undefined;
  }
  return {
    mode: repository.promotion.mode ?? "shared-target",
    productionBranch:
      repository.promotion.productionBranch ?? repository.defaultBranch,
    remote: repository.promotion.remote ?? "origin",
    reviewers:
      repository.promotion.reviewers ??
      repository.globalDefaultPromotion?.reviewers ??
      [],
    assignees:
      repository.promotion.assignees ??
      repository.globalDefaultPromotion?.assignees ??
      [],
  };
}

export async function promoteByPullRequest(
  repository: RepositoryConfig,
  session: Session,
): Promise<string | undefined> {
  const promotion = pullRequestPromotion(repository);
  if (!promotion) return undefined;
  const head =
    promotion.mode === "session-branch"
      ? session.branch
      : targetBranch(repository);
  const headCommit =
    promotion.mode === "session-branch"
      ? session.readyCommit
      : session.promotedCommit;
  if (!headCommit) {
    throw new Error(
      `Pull-request promotion is missing the ${promotion.mode === "session-branch" ? "ready" : "promoted"} commit`,
    );
  }
  await validateBranch(repository.path, head, "pull-request head");
  await validateBranch(
    repository.path,
    promotion.productionBranch,
    "pull-request base",
  );
  if (head === promotion.productionBranch) {
    throw new Error(
      `Pull-request promotion requires different target and production branches; both resolve to ${head}`,
    );
  }

  await checked(
    "git",
    ["remote", "get-url", promotion.remote],
    repository.path,
    `Pull-request promotion remote ${promotion.remote} is not configured`,
  );
  await checked(
    "gh",
    ["auth", "status"],
    repository.path,
    "GitHub authentication is unavailable",
  );
  const remoteBase = (
    await checked(
      "git",
      [
        "ls-remote",
        "--exit-code",
        "--heads",
        promotion.remote,
        promotion.productionBranch,
      ],
      repository.path,
      `Could not find base branch ${promotion.productionBranch} on ${promotion.remote}`,
    )
  )
    .trim()
    .split(/\s+/)[0];
  if (!remoteBase || remoteBase === headCommit) {
    throw new Error(
      `Pull-request promotion requires different base and head commits; both resolve to ${headCommit}`,
    );
  }

  await checked(
    "git",
    ["push", promotion.remote, `${headCommit}:refs/heads/${head}`],
    repository.path,
    `Could not push ${head} to ${promotion.remote}`,
  );

  const existing = await checked(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--base",
      promotion.productionBranch,
      "--head",
      head,
      "--json",
      "url,body",
      "--limit",
      "1",
    ],
    repository.path,
    "Could not inspect existing pull requests",
  );
  const pullRequests = parsePullRequests(existing);
  const marker = `codex-handoff-session:${session.id}`;
  let url =
    promotion.mode === "session-branch"
      ? pullRequests.find((pullRequest) => pullRequest.body.includes(marker))
          ?.url
      : pullRequests[0]?.url;
  if (promotion.mode === "session-branch" && pullRequests.length > 0 && !url) {
    throw new Error(
      `Open pull request for ${head} does not belong to session ${session.id}; refusing to reuse or modify it`,
    );
  }
  if (!url) {
    const args = [
      "pr",
      "create",
      "--base",
      promotion.productionBranch,
      "--head",
      head,
      "--title",
      `Promote ${head} to ${promotion.productionBranch}`,
      "--body",
      `${marker}\n\nAutomated promotion after codex-handoff session ${session.id}.\n\n${session.completionSummary ?? session.taskSummary}`,
    ];
    if (promotion.reviewers.length > 0) {
      args.push("--reviewer", promotion.reviewers.join(","));
    }
    if (promotion.assignees.length > 0) {
      args.push("--assignee", promotion.assignees.join(","));
    }
    url = (
      await checked(
        "gh",
        args,
        repository.path,
        "Could not create promotion pull request",
      )
    ).trim();
  } else {
    if (promotion.reviewers.length > 0) {
      await checked(
        "gh",
        ["pr", "edit", url, "--add-reviewer", promotion.reviewers.join(",")],
        repository.path,
        "Could not request promotion reviewers",
      );
    }
    if (promotion.assignees.length > 0) {
      await checked(
        "gh",
        ["pr", "edit", url, "--add-assignee", promotion.assignees.join(",")],
        repository.path,
        "Could not assign promotion pull request",
      );
    }
  }
  if (!url) throw new Error("GitHub did not return a pull request URL");
  return url;
}

async function checked(
  command: string,
  args: string[],
  cwd: string,
  message: string,
): Promise<string> {
  const result = await run(command, args, { cwd });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${message}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

async function validateBranch(
  cwd: string,
  branch: string,
  label: string,
): Promise<void> {
  await checked(
    "git",
    ["check-ref-format", "--branch", branch],
    cwd,
    `Invalid ${label} branch ${branch}`,
  );
}

function parsePullRequests(
  value: string,
): Array<{ url: string; body: string }> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { url?: unknown }).url === "string" &&
          typeof (item as { body?: unknown }).body === "string",
      )
    ) {
      return parsed as Array<{ url: string; body: string }>;
    }
  } catch {
    // The actionable error below covers malformed CLI output.
  }
  throw new Error("Could not parse GitHub pull request response");
}
