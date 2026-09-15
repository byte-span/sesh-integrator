---
name: sesh-integrator-workflow
description: Use for most code-changing Codex CLI tasks in Git repositories that should run in an isolated source worktree and be validated and promoted by the local sesh-integrator tool. Automatically register and begin or continue a session, then create a focused commit, validate, integrate, and resume when safe. Never use for read-only work, non-Git directories, sesh-integrator itself, its integration branch, or the legacy codex-integrator workflow.
---

# Sesh Integrator Workflow

This skill coordinates a coding session with the local `sesh-integrator` CLI.

It does not perform daemon monitoring.

Use `seshx` as the preferred command. `sesh-integrator`, `pintx`,
`parallel-integrator`, and `codex-handoff` remain compatible aliases. Existing
runtime data and configured branch names remain in place.

Runtime paths below use the fresh-install default. If `SESH_INTEGRATOR_HOME`, `PARALLEL_INTEGRATOR_HOME`
or compatibility `CODEX_HANDOFF_HOME` is set, use that directory instead.
Otherwise reuse `~/.codex-handoff/` first, then `~/.parallel-integrator/` if present;
fresh installations use `~/.sesh-integrator/`. Do not move existing session or worktree data.

## Start of a code-changing task

Check `seshx status` for the current repository's enablement before registration
or session recovery. If it reports `Enablement: disabled`, skip this workflow
and follow the repository's normal development instructions. Do not automatically
register, begin, resume, or run `seshx enable` to bypass an opt-out. Registration
and enablement are independent; registration never clears a disabled setting.
Only enable the repository when the user requests it.

Before modifying files:

1. Confirm this is code-changing work in a Git repository and is not work on
   `sesh-integrator` itself or its configured integration branch.
2. Inspect repository instructions and Git state. Never reset, overwrite,
   discard, clean, or silently stash existing user state.
3. Check whether `seshx` is available and inspect
   `seshx status`. Continue an active or recoverable session for this
   task from its recorded source path. Do not replace a different task's
   session.
4. If the repository is unregistered, autonomously run:

   ```bash
   seshx register --auto-config
   ```

5. Before beginning, compare the effective target reported by
   `seshx status` with repository instructions. When the default branch
   is stable but agent work must land on another branch such as `dev`, set the
   global `defaultTargetBranch` accordingly in `~/.sesh-integrator/config.json`.
   It applies to existing and new registrations that omit `targetBranch`; keep
   per-repository `targetBranch` values only as explicit exceptions.
6. If no appropriate session exists, run:

   ```bash
   seshx begin --create-worktree --summary "<concise task summary>"
   ```

   From an ordinary checkout, the command creates a unique task branch and
   source worktree. From an existing linked worktree it reuses that worktree.
   Read `Continue task in: <path>` from the output and perform every subsequent
   edit and handoff command from that path. Do not edit the launch checkout.
   An active session launched from that ordinary checkout does not block a new
   unrelated task: begin another managed worktree. If a lifecycle command from
   the shared launch checkout reports multiple matches, select the intended one
   with `--session <session-id>`; do not infer task identity from timing.

7. `begin` runs centrally configured setup commands before creating a task
   branch or session. Auto-configured setup failures warn and continue; explicit
   setup failures stop. Do not stop solely for the advisory warning.
8. If `begin` reports a changed setup result, an indeterminate Git error, or the
   handoff integration branch, stop and explain. A newly created worktree may be
   preserved after failure; do not delete it or its branch automatically.
9. For an already-linked/in-place source, if `begin` reports staged baseline
   state, stop. Pre-existing unstaged paths may proceed only under the CLI's
   recorded-baseline diagnostics. Never create or switch a branch manually as a
   workaround. Dirty or staged state in an ordinary launch checkout is left
   untouched and excluded from the new task worktree.
10. If the user explicitly says this work depends on another handoff session,
    pass its ID with `--depends-on`.
11. Do not infer dependencies from start time alone.

## During work

- Follow repository `AGENTS.md`.
- Work only in the source path recorded by the active session.
- Keep changes scoped to the task.
- Do not invoke the legacy `codex-integrator`.
- Do not merge into the integration branch manually.

### Maintain the session checklist

After beginning or recovering a session, inspect `seshx tasks list` and maintain
its existing plan. For a new checklist, add ordered, task-specific milestones:

```bash
seshx tasks add --title "Inspect existing behavior" --title "Implement changes" --title "Verify and integrate"
seshx tasks update 1 --status in_progress
```

Do this before implementation so the dashboard can show progress. Titles should
be short and concrete; use `--description` for detail. Tasks default to pending.
Mark a task completed when its work is finished, then mark the next task
in_progress. Only one task can be in_progress. Use blocked or skipped with an
explicit `--reason` when needed. Never mark unfinished work completed.

As the plan changes, add discoveries, clarify a task with `tasks update <id>
--title "..."`, and reorder with `tasks move <id> --position <n>`. IDs remain
stable after reordering; use the IDs printed by the CLI. To split work, add the
replacement tasks and skip the original with a reason. Keep completed and
skipped entries as history. Update the checklist promptly at each transition,
including after successful integration; do not wait until the final response.
Use `--session <session-id>` when selection from the launch checkout is ambiguous.
Do not write the session JSON directly or record any secret values. Checklist
status is agent-reported and never replaces required validation or promotion.

### Finish when no changes are needed

If inspection shows the requested work is already implemented and this session
has no new changes, finish its checklist truthfully (skip unnecessary work with
reasons), then run:

```bash
seshx finish --no-changes --summary "<why no changes are needed>" [--session <id>] [--satisfied-by <successful-session-id>]
```

This is required before the final response; skipping tasks alone does not close
the session. The CLI verifies the unchanged source branch/commit and observable
working-tree baseline, rejects integration/recovery state and unfinished tasks,
and records `no_changes` without creating or promoting a commit. Never create an
empty commit or integrate just to close a no-change session. If an earlier
successful session already delivered the work, pass its ID with `--satisfied-by`;
the CLI verifies its source commit is present and retains its outstanding PR
review and rollout obligations. Report the current no-change session and the
referenced integration separately. Inspect `seshx status --session <id>` before
reporting completion. A terminal response does not update stored session status.

## Completion

Before saying the task is complete:

1. Inspect the task diff and `git status`.
2. If task changes are uncommitted:
   - confirm they belong to this task
   - confirm the branch is safe
   - stage only the intended task paths
   - create one focused commit through the controlled command so signing is
     preflighted immediately before Git creates the commit:

     ```bash
     seshx commit --message "<focused commit message>"
     ```

   - never substitute a raw `git commit` when a handoff session is active
3. If unrelated/ambiguous changes are present, ask before staging or committing.
4. Require no newly introduced or changed non-task working-tree state. An
   observably unchanged baseline path may remain only when `validate` explicitly
   reports that it is preserved and excluded; do not claim an inaccessible
   path's disk contents were verified.
5. Run `seshx validate`. It chooses configured validation commands from
   the exact committed diff; do not manually substitute a cheaper tier.
6. If validation fails, inspect the complete failure evidence before stopping.
   An exit code is evidence, not a verdict about whether the failure is
   deterministic. When retrying is plausibly safe, rerun the unchanged
   `seshx validate` command, for at most three total attempts. Do not
   edit code merely to make a retry pass. Stop after repeated failure or when
   the evidence identifies a code defect, and never integrate without
   successful validation. If validation succeeds while warning that a
   baseline-inaccessible tracked path is preserved and excluded, continue to
   `integrate`; do not independently reject that path or inspect the integration
   worktree before the CLI does.
7. Run:

   ```bash
   seshx integrate --summary "<concise completion summary>" \
     --rollout <none|applied|automated|manual> \
     [--follow-up "<required manual action>"]...
   ```

8. If `integrate` reports a resumable merge conflict:
   - read the saved conflict prompt
   - inspect and resolve the preserved integration worktree reported by the CLI
   - preserve compatible intent, remove all conflict markers, and stage the resolved files
   - do not commit in the integration worktree
   - run `seshx resume` from the original source worktree
   - continue autonomously unless the conflict is genuinely ambiguous or validation fails
9. If a clean merge was preserved after validation or commit creation failed,
   run `seshx resume` from the original source worktree. The CLI must
   verify that its exact staged merge tree is unchanged before retrying.
   Every integration validation failure is recorded as `validation_pending`;
   it is resumable by the same command after evidence review and does not
   require reclassifying it as `needs_review`.
   Resume treats the durable recovery bundle as authoritative and reconstructs
   a fresh, hash-verified recovery worktree. Do not move, edit, or delete files
   under `~/.sesh-integrator/recovery-bundles/` or refs under
   `refs/codex-handoff/recovery/`; the previously shared integration worktree
   may no longer be the worktree reported after resume.
10. If validation succeeded but target promotion reports
    `promotion_pending`, preserve the staging commit. Correct only the reported
    condition (for example, check out the target branch or save and clean user
    changes in its worktree)
    and run `seshx resume`. Do not reset, clean, or discard user state.
11. If shared-target remote recovery reports a conflict, resolve and stage only
    the preserved integration worktree it names, then run `seshx
resume`. Do not fetch, merge, push, reset, or retry manually; the CLI owns
    the exact fetched commit, full revalidation, and bounded non-force retries.
12. For any other integration failure, inspect the CLI's complete preserved
    evidence and incident diagnosis. Treat classifications as evidence, not a
    verdict. If retrying the unchanged result is safe, run `seshx
resume` in the same session for at most three total attempts. Report a
    blocker only after those attempts fail or the evidence identifies a code
    defect, ambiguity, or required external change. Do not start a replacement
    session merely to retry integration, and never edit workflow instructions
    or tool code from the failed session itself.
13. Classify external-state rollout for every integration. `none` means no
    external state is affected; `applied` means it is already applied;
    `automated` means trusted automation will apply it; and `manual` requires
    one or more explicit `--follow-up` actions. Source promotion never implies
    that migrations, infrastructure, configuration, secrets, jobs, backfills,
    or deployment state were applied.
14. Report:

- session ID
- source commit
- staging integration commit
- target branch and promoted commit if successful
- pull-request URL when one was created or reused
- `promotion_pending` or `needs_review` details if unsuccessful
- all required manual follow-up steps, or `No manual follow-up required.` when
  there are none

Requests for concision never override these required completion fields. Use the
CLI's compact `Completion summary` block as the reporting baseline and do not
omit a populated pull-request URL.

For each `--follow-up`, record one actionable outstanding step: what to do,
where to do it (system, repository/project, environment), and exact configuration
names when known. Verify names from non-secret source/configuration; do not
invent missing names. For credentials, record only names and destination and
say to configure them on a trusted machine. Never request, read, store, or print
secret values, including in CLI arguments or session records.

Before the final response, use the latest `Completion summary` (available again
with `seshx status --session <session-id>`) and check every recorded
action against the response. Preserve every outstanding action and its essential
details, even when concise: action, destination, exact names, and prerequisites.
Do not collapse setup into a label such as “complete CWS setup.” Documentation
links may supplement instructions but must not replace known essential steps.
Keep completed actions separate from outstanding ones. After successful recovery,
report resolved integration prerequisites as completed, not required follow-ups;
do not copy old errors or incident fixes into the outstanding list. Record only
outstanding external work in `--follow-up`, not prerequisites the session already
resolved. Recovery alone does not resolve recorded external setup actions. If an
external action was subsequently completed with evidence, explicitly report that
completion instead of silently omitting it or repeating it as outstanding.

Source promotion success is separate from external setup or rollout completion.
`automated` means delegated, not verified complete. Use `No manual follow-up
required.` only when no required actions remain, including review/merge and
unresolved prerequisites. Requests for concision never override these details.

## Concurrent integration

If another session is integrating the repository, `seshx integrate` may wait for the repository lock.

Do not start an alternative merge while waiting.

Never monitor that wait with an unbounded shell polling loop such as
`while pgrep`. Use the execution tool's session-aware wait operation, or bounded
retries against a specific process/session identifier with an explicit timeout.

## Failure

If `integrate` fails:

- do not claim integration succeeded
- do not run destructive Git cleanup
- preserve the reported integration worktree
- automatically follow the resumable-conflict procedure above when offered
- otherwise report the status and recommended next action
- distinguish a validated staging result from completed target promotion

## Boundaries

Never:

- push
- force-push
- reset user worktrees
- delete branches/worktrees
- invoke the legacy daemon workflow
- treat earlier start time as automatic precedence

The `push` boundary applies to agent-issued Git commands. An explicitly
configured `promotion.type: "pull-request"` authorizes `sesh-integrator` itself to
perform its narrow non-force target push and create or update the configured PR.
