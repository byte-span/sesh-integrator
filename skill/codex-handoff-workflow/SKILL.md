---
name: codex-handoff-workflow
description: Use for code-changing tasks running in Codex Worktree mode that should be staged, validated, and promoted to the configured target by the local codex-handoff tool. At task start, record the session/base commit; at completion, validate, create a focused commit when safe, and run one-shot integration. Never use in Codex Local mode, for read-only tasks, on the codex-handoff integration branch, or with the legacy codex-integrator daemon workflow.
---

# Codex Handoff Workflow

This skill coordinates a coding session with the local `codex-handoff` CLI.

It does not perform daemon monitoring.

## Start of a code-changing task

Before modifying files:

1. Apply the environment eligibility gate before calling any `codex-handoff`
   command:
   - If the current Codex chat is in Local mode, do not use this skill. Continue
     the task directly in the current project directory without beginning,
     registering, validating, or integrating a handoff session. Local mode is
     authoritative even when the repository is registered or the checkout is
     technically a Git worktree.
   - Use this workflow when the chat is in Worktree mode.
   - If the Codex mode is not available, proceed only when the checkout is
     verifiably a linked Git worktree. Resolve the paths returned by both
     commands:
     - `git rev-parse --git-dir`
     - `git rev-parse --git-common-dir`
   - If the resulting paths are equal or the distinction cannot be verified,
     continue without handoff.
2. Confirm the current directory belongs to a Git repository.
3. Check whether `codex-handoff` is available.
4. Run:

   ```bash
   codex-handoff begin --summary "<concise task summary>"
   ```

   `begin` records the observable pre-setup Git baseline and creates a unique `codex/session-...` branch when the worktree
   is detached or on the registered default branch. It leaves an existing
   non-default branch unchanged.

5. If the repository is not registered, ask the user whether to register it.
6. If approved:

   ```bash
   codex-handoff register --auto-config
   codex-handoff begin --summary "<concise task summary>"
   ```

7. `begin` runs centrally configured setup commands before creating a task
   branch or session. Auto-configured setup failures warn and continue; explicit
   setup failures stop. Do not stop solely for the advisory warning.
8. If `begin` reports staged baseline state, a changed setup result, an
   indeterminate Git error, or the handoff integration branch, stop and explain.
   Pre-existing unstaged paths may proceed only under the CLI's recorded-baseline
   diagnostics. Never create or switch a branch manually as a workaround.
9. If the user explicitly says this work depends on another handoff session, pass its ID with `--depends-on`.
10. Do not infer dependencies from start time alone.

## During work

- Follow repository `AGENTS.md`.
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
   codex-handoff integrate --summary "<concise completion summary>"
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
10. If validation succeeded but target promotion reports
    `promotion_pending`, preserve the staging commit. Correct only the reported
    condition (for example, check out the target branch or save and clean user
    changes in its worktree)
    and run `codex-handoff resume`. Do not reset, clean, or discard user state.
11. For any other integration failure, report the CLI's recorded error; do not
    describe the session as `needs_review` unless the CLI recorded that status.
12. Report:

- session ID
- source commit
- staging integration commit
- target branch and promoted commit if successful
- `promotion_pending` or `needs_review` details if unsuccessful

## Concurrent integration

If another session is integrating the repository, `codex-handoff integrate` may wait for the repository lock.

Do not start an alternative merge while waiting.

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
