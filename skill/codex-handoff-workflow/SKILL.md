---
name: codex-handoff-workflow
description: Use for code-changing tasks in Git worktrees that should be integrated by the local codex-handoff tool. At task start, record the session/base commit; at successful completion, validate, create a focused commit when safe, and run one-shot integration. Do not use for read-only tasks, default branches, the codex-handoff integration branch, or the legacy codex-integrator daemon workflow.
---

# Codex Handoff Workflow

This skill coordinates a coding session with the local `codex-handoff` CLI.

It does not perform daemon monitoring.

## Start of a code-changing task

Before modifying files:

1. Confirm the current directory belongs to a Git repository.
2. Check whether `codex-handoff` is available.
3. Run:

   ```bash
   codex-handoff begin --summary "<concise task summary>"
   ```

4. If the repository is not registered, ask the user whether to register it.
5. If approved:

   ```bash
   codex-handoff register
   codex-handoff begin --summary "<concise task summary>"
   ```

6. If the worktree is dirty, detached, on the default branch, or on the handoff integration branch, stop and explain.
7. If the user explicitly says this work depends on another handoff session, pass its ID with `--depends-on`.
8. Do not infer dependencies from start time alone.

## During work

- Follow repository `AGENTS.md`.
- Keep changes scoped to the task.
- Do not invoke the legacy `codex-integrator`.
- Do not merge into the integration branch manually.

## Completion

Before saying the task is complete:

1. Inspect the task diff and `git status`.
2. Run the repository's configured source validation commands.
3. If validation fails, stop. Do not integrate.
4. If task changes are uncommitted:
   - confirm they belong to this task
   - confirm the branch is safe
   - create one focused commit using repository conventions
5. If unrelated/ambiguous changes are present, ask before staging or committing.
6. Require a clean worktree.
7. Run:

   ```bash
   codex-handoff integrate --summary "<concise completion summary>"
   ```

8. Report:
   - session ID
   - source commit
   - integration result
   - integration commit if successful
   - `needs_review` details if unsuccessful

## Concurrent integration

If another session is integrating the repository, `codex-handoff integrate` may wait for the repository lock.

Do not start an alternative merge while waiting.

## Failure

If `integrate` fails:

- do not claim integration succeeded
- do not run destructive Git cleanup
- preserve the reported integration worktree
- report the status and recommended next action

## Boundaries

Never:

- push
- force-push
- reset user worktrees
- delete branches/worktrees
- invoke the legacy daemon workflow
- treat earlier start time as automatic precedence
