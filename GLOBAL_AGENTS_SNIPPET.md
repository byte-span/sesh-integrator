# codex-handoff global workflow

For most code-changing tasks inside a Git repository, use `codex-handoff` from
the current Codex CLI checkout. Do not use it for read-only work, non-Git
directories, or changes to the `codex-handoff` repository itself. Do not invoke
the legacy `codex-integrator` workflow for repositories using `codex-handoff`.

Operate autonomously by default. Do not ask for routine approval to register,
begin, validate, commit, integrate, resume, or safely promote local work that is
already within the user's request.

Before editing:

1. Inspect the repository instructions and Git state. Preserve all pre-existing
   user changes; never reset, overwrite, discard, clean, or silently stash them.
2. Inspect `codex-handoff status`. If the current checkout already has an active
   or recoverable handoff session for the same task, continue that session at
   its recorded phase instead of beginning another one. If it belongs to a
   different task, stop and report the mismatch without altering it.
3. If the repository is unregistered, run:

   ```bash
   codex-handoff register --auto-config
   ```

   Registration is automatic and does not require routine approval.
   Before beginning, compare the effective target shown by
   `codex-handoff status` with the repository's branch policy. If agents must
   work on a branch such as `dev` while `main` remains stable, set the global
   `defaultTargetBranch` to `dev` in `~/.codex-handoff/config.json`. This policy
   applies automatically to existing and new registrations that omit a
   repository `targetBranch`; use that per-repository field only for explicit
   exceptions.

4. If no appropriate session exists, run:

   ```bash
   codex-handoff begin --create-worktree --summary "<concise task summary>"
   ```

   From an ordinary checkout, `--create-worktree` creates a unique task branch
   in a separate source worktree and prints `Continue task in: <path>`. Perform
   every subsequent file edit and handoff command from that path. If the CLI
   session already started in a linked worktree, the command reuses it. The
   launch checkout and all dirty or staged user state there remain untouched;
   never copy that state into the task worktree unless the user explicitly
   makes it part of the task.

5. Never begin on `codex-handoff/integration` (or the repository's configured
   integration branch). Pass `--depends-on` only for explicit dependencies.

At completion:

1. Inspect the task diff and Git status. Stage only intended task paths and
   preserve unrelated state.
2. Create one focused source commit through:

   ```bash
   codex-handoff commit --message "<focused commit message>"
   ```

3. Run `codex-handoff validate`; do not integrate if validation fails.
4. Run `codex-handoff integrate --summary "<concise completion summary>"`.
5. For a resumable conflict, resolve and stage the preserved integration
   worktree without committing there, then run `codex-handoff resume` from the
   original source checkout. Preserve compatible intent and continue
   autonomously unless the conflict is genuinely ambiguous or validation fails.
6. For `promotion_pending`, preserve the validated staging commit, correct only
   the reported blocking condition without disturbing user state, and run
   `codex-handoff resume`. Do not claim success until promotion and configured
   post-integration checks complete.
7. Report the session, source commit, integration result, target promotion, and
   every required manual follow-up step. If none remain, state
   `No manual follow-up required.`

Never push, force-push, deploy, or perform destructive remote actions unless the
user clearly requests that specific external action. Never delete branches or
worktrees, reset a user checkout, discard changes, or trade away user state to
make handoff succeed.
