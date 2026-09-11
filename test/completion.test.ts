import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCompletionSummary } from "../src/completion.js";
import type { Session } from "../src/types.js";

afterEach(() => vi.restoreAllMocks());

function summary(overrides: Partial<Session> = {}): string {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  writeCompletionSummary({
    id: "session_fixture",
    status: "succeeded",
    repositoryPath: "/repo",
    repositoryId: "repo",
    worktreePath: "/source",
    branch: "task",
    startCommit: "base",
    integrationCommitAtStart: null,
    startedAt: "2026-09-11",
    taskSummary: "Release",
    dependsOn: [],
    readyCommit: "source",
    integratedCommit: "staging",
    targetBranch: "dev",
    promotedCommit: "staging",
    rolloutDisposition: "none",
    ...overrides,
  });
  return output.mock.calls.map(([text]) => text).join("");
}

describe("completion reporting", () => {
  it("preserves all action text, including multiline names and supplemental links, alongside PR review", () => {
    const action =
      "On a trusted machine, add to the chrome-web-store GitHub environment:\nCWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN.\nSee docs/release.md.";
    const output = summary({
      rolloutDisposition: "manual",
      rolloutFollowUps: [action],
      pullRequestUrl: "https://example.test/pull/1",
    });
    expect(output).toContain(action);
    expect(output).toContain("Required manual actions (2 recorded)");
    expect(output).toContain("Review and merge https://example.test/pull/1.");
    expect(output).not.toContain("No manual follow-up required.");
  });

  it.each([undefined, "manual"] as const)(
    "does not declare legacy %s rollout complete without its required metadata",
    (rolloutDisposition) => {
      const output = summary({ rolloutDisposition });
      expect(output).toContain("rollout record is incomplete");
      expect(output).not.toContain("No manual follow-up required.");
    },
  );

  it("does not discard legacy follow-ups when disposition is missing", () => {
    expect(
      summary({
        rolloutDisposition: undefined,
        rolloutFollowUps: [
          "Configure FIXTURE_CHANNEL in GitHub environment test.",
        ],
      }),
    ).toContain("Configure FIXTURE_CHANNEL in GitHub environment test.");
  });

  it("distinguishes delegated automation from verified external completion", () => {
    const output = summary({ rolloutDisposition: "automated" });
    expect(output).toContain("Target promotion: dev at staging");
    expect(output).toContain("completion not verified by codex-handoff");
    expect(output).toContain("No manual follow-up required.");
  });

  it("does not treat an already promoted source with failed checks as completed", () => {
    const output = summary({
      status: "needs_review",
      recoveryPhase: "post_integration",
      latestError: "Post-integration check failed",
    });
    expect(output).toContain("Target promotion: dev at staging");
    expect(output).toContain(
      "Outstanding integration prerequisite: Post-integration check failed",
    );
    expect(output).not.toContain("No manual follow-up required.");
  });
});
