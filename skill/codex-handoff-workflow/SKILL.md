---
name: codex-handoff-workflow
description: Use for most code-changing Codex CLI tasks in Git repositories that should run in an isolated source worktree and be validated and promoted by the local codex-handoff tool. Automatically register and begin or continue a session, then create a focused commit, validate, integrate, and resume when safe. Never use for read-only work, non-Git directories, codex-handoff itself, its integration branch, or the legacy codex-integrator workflow.
---

# Codex Handoff Workflow

This skill coordinates a coding session with the local `codex-handoff` CLI.

It does not perform daemon monitoring.

## Start of a code-changing task

Before modifying files:

1. Confirm this is code-changing work in a Git repository and is not work on
   `codex-handoff` itself or its configured integration branch.
2. Inspect repository instructions and Git state. Never reset, overwrite,
   discard, clean, or silently stash existing user state.
3. Check whether `codex-handoff` is available and inspect
   `codex-handoff status`. Continue an active or recoverable session for this
   task from its recorded source path. Do not replace a different task's
   session.
4. If the repository is unregistered, autonomously run:

   ```bash
   codex-handoff register --auto-config
   ```

5. Before beginning, compare the effective target reported by
   `codex-handoff status` with repository instructions. When the default branch
   is stable but agent work must land on another branch such as `dev`, set the
   global `defaultTargetBranch` accordingly in `~/.codex-handoff/config.json`.
   It applies to existing and new registrations that omit `targetBranch`; keep
   per-repository `targetBranch` values only as explicit exceptions.
6. If no appropriate session exists, run:

   ```bash
   codex-handoff begin --create-worktree --summary "<concise task summary>"
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
     codex-handoff commit --message "<focused commit message>"
     ```

   - never substitute a raw `git commit` when a handoff session is active
3. If unrelated/ambiguous changes are present, ask before staging or committing.
4. Require no newly introduced or changed non-task working-tree state. An
   observably unchanged baseline path may remain only when `validate` explicitly
   reports that it is preserved and excluded; do not claim an inaccessible
   path's disk contents were verified.
5. Run `codex-handoff validate`. It chooses configured validation commands from
   the exact committed diff; do not manually substitute a cheaper tier.
6. If validation fails, stop. Do not integrate. If validation succeeds while
   warning that a baseline-inaccessible tracked path is preserved and excluded,
   continue to `integrate`; do not independently reject that path or inspect the
   integration worktree before the CLI does.
7. Run:

   ```bash
   codex-handoff integrate --summary "<concise completion summary>" \
     --rollout <none|applied|automated|manual> \
     [--follow-up "<required manual action>"]...
   ```

8. If `integrate` reports a resumable merge conflict:
   - read the saved conflict prompt
   - inspect and resolve the preserved integration worktree reported by the CLI
   - preserve compatible intent, remove all conflict markers, and stage the resolved files
   - do not commit in the integration worktree
   - run `codex-handoff resume` from the original source worktree
   - continue autonomously unless the conflict is genuinely ambiguous or validation fails
9. If a clean merge was preserved after validation or commit creation failed,
   run `codex-handoff resume` from the original source worktree. The CLI must
   verify that its exact staged merge tree is unchanged before retrying.
   An exhausted transient validation is recorded as `validation_pending`; it is
   resumable by the same command and does not require reclassifying it as
   `needs_review`.
   Resume treats the durable recovery bundle as authoritative and reconstructs
   a fresh, hash-verified recovery worktree. Do not move, edit, or delete files
   under `~/.codex-handoff/recovery-bundles/` or refs under
   `refs/codex-handoff/recovery/`; the previously shared integration worktree
   may no longer be the worktree reported after resume.
10. If validation succeeded but target promotion reports
    `promotion_pending`, preserve the staging commit. Correct only the reported
    condition (for example, check out the target branch or save and clean user
    changes in its worktree)
    and run `codex-handoff resume`. Do not reset, clean, or discard user state.
11. If shared-target remote recovery reports a conflict, resolve and stage only
    the preserved integration worktree it names, then run `codex-handoff
resume`. Do not fetch, merge, push, reset, or retry manually; the CLI owns
    the exact fetched commit, full revalidation, and bounded non-force retries.
12. For any other integration failure, report the CLI's recorded error; do not
    describe the session as `needs_review` unless the CLI recorded that status.
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

## Concurrent integration

If another session is integrating the repository, `codex-handoff integrate` may wait for the repository lock.

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
configured `promotion.type: "pull-request"` authorizes `codex-handoff` itself to
perform its narrow non-force target push and create or update the configured PR.
