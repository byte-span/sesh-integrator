---
name: codex-handoff-workflow
description: Use for code-changing tasks in Git worktrees that should be integrated by the local codex-handoff tool. At task start, safely create a task branch when needed and record the session/base commit; at successful completion, validate, create a focused commit when safe, and run one-shot integration. Do not use for read-only tasks, the codex-handoff integration branch, or the legacy codex-integrator daemon workflow.
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

   `begin` creates a unique `codex/session-...` branch when the clean worktree
   is detached or on the registered default branch. It leaves an existing
   non-default branch unchanged.

4. If the repository is not registered, ask the user whether to register it.
5. If approved:

   ```bash
   codex-handoff register --auto-config
   codex-handoff begin --summary "<concise task summary>"
   ```

6. `begin` runs centrally configured setup commands before creating a task
   branch or session. Auto-configured setup failures warn and continue; explicit
   setup failures stop. Do not stop solely for the advisory warning.
7. If the worktree is dirty or on the handoff integration branch, stop and explain. Never create or switch a branch manually as a workaround for `begin`.
8. If the user explicitly says this work depends on another handoff session, pass its ID with `--depends-on`.
9. Do not infer dependencies from start time alone.

## During work

- Follow repository `AGENTS.md`.
- Keep changes scoped to the task.
- Do not invoke the legacy `codex-integrator`.
- Do not merge into the integration branch manually.

## Completion

Before saying the task is complete:

1. Inspect the task diff and `git status`.
2. Read the matching repository entry in `~/.codex-handoff/config.json` and run each
   `sourceValidationCommands` argument array directly, in order, from the source worktree.
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
