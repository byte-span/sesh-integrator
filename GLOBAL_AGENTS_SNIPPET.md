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

4. If no appropriate session exists, run:

   ```bash
   codex-handoff begin --summary "<concise task summary>"
   ```

   `begin` works in the current checkout. It may create and switch to a unique
   task branch there when the checkout is detached or on the registered default
   or target branch, but it does not create a separate task worktree. Do not
   claim otherwise. Pre-existing unstaged changes may proceed only under the
   CLI's recorded-baseline checks; staged or indeterminate state blocks `begin`.
   Never manipulate user state or switch branches manually to bypass a block.

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
