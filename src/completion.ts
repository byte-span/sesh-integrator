import type { RolloutDisposition, Session } from "./types.js";

// Follow-ups are declarations, not inferred from error messages or task summaries.
// Recovery clears blockers; it does not prove external setup was performed.
export function writeCompletionSummary(session: Session): void {
  const followUps = [
    ...(session.pullRequestUrl
      ? [`Review and merge ${session.pullRequestUrl}.`]
      : []),
    ...(session.rolloutFollowUps ?? []),
  ];
  const noChanges = session.status === "no_changes";
  const succeeded = session.status === "succeeded" || noChanges;
  const unclassified = !session.rolloutDisposition;
  const missingActions =
    session.rolloutDisposition === "manual" &&
    !session.rolloutFollowUps?.length;
  process.stdout.write(
    `Completion summary:\n` +
      `  Session: ${session.id}\n` +
      `  Source commit: ${noChanges ? `No new commit (base ${session.startCommit})` : (session.readyCommit ?? "Not recorded")}\n` +
      `  Staging integration commit: ${noChanges ? "Not required" : (session.integratedCommit ?? "Not recorded")}\n` +
      (noChanges
        ? "  Target promotion: Not performed; no new changes.\n"
        : `  Target promotion: ${session.targetBranch ?? "Not recorded"} at ${session.promotedCommit ?? "Not promoted"}\n`) +
      (noChanges
        ? `  Outcome: Finished - no changes needed.\n  Summary: ${session.completionSummary ?? ""}\n`
        : "") +
      (session.satisfiedBySessionId
        ? `  Satisfied by session: ${session.satisfiedBySessionId}\n`
        : "") +
      `  Source integration: ${session.status}\n` +
      `  Pull request: ${session.pullRequestUrl ?? "None"}\n` +
      `  External rollout: ${formatRolloutDisposition(session.rolloutDisposition)}\n` +
      (!succeeded
        ? `  Outstanding integration prerequisite: ${session.latestError ?? "Complete integration and its configured checks."}\n`
        : "") +
      `  Required manual actions (${followUps.length} recorded):\n` +
      followUps.map((item) => `  Manual follow-up: ${item}\n`).join("") +
      (unclassified || missingActions
        ? `  Manual follow-up: Establish the external rollout requirements and report every outstanding action; this session's rollout record is incomplete.\n`
        : !followUps.length && succeeded
          ? `  Manual follow-up: No manual follow-up required.\n`
          : "") +
      `  Final response: Preserve every outstanding action above with its destination and exact configuration names, even when concise. Links supplement steps; they do not replace them. Report resolved prerequisites as completed, not required. Never include secret values.\n`,
  );
}

function formatRolloutDisposition(
  disposition: RolloutDisposition | undefined,
): string {
  switch (disposition) {
    case "none":
      return "None required.";
    case "applied":
      return "Already applied (declared by agent).";
    case "automated":
      return "Delegated to trusted automation; completion not verified by sesh-integrator.";
    case "manual":
      return "Manual action required.";
    default:
      return "Unclassified.";
  }
}
