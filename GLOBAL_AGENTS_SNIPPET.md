# codex-handoff global workflow

For code-changing work inside a Git repository (except for `codex-handoff`
itself), use this workflow only when the current Codex chat runs in Worktree
mode. Local mode is an explicit opt-out: continue the task directly in the
current project directory without calling any `codex-handoff` command, even if
the repository is registered.

If the Codex mode is unavailable, verify a linked Git worktree by resolving the
paths returned by both commands:

- `git rev-parse --git-dir`
- `git rev-parse --git-common-dir`

The resulting paths must differ. If they are the same or the distinction cannot
be verified, skip `codex-handoff`.

For eligible Worktree-mode tasks:

1. Use `$codex-handoff-workflow` before making edits.
2. If the repository is not registered with `codex-handoff`, ask whether to register it.
3. If approved, register it with `codex-handoff register --auto-config`, then begin the handoff session.
4. Do not use this workflow for read-only questions or investigations that make no code changes.
5. Let the skill create a task branch automatically from a clean detached/default-branch worktree; never begin on `codex-handoff/integration`.
6. Before declaring coding work complete, use the same skill to validate, create a focused commit when safe, and run one-shot integration.
7. If integration reports a resumable conflict, resolve and stage the preserved integration worktree, then run `codex-handoff resume` from the source worktree. Otherwise report `needs_review` instead of claiming success.
8. Do not invoke the legacy `codex-integrator` workflow for repositories using `codex-handoff`.
