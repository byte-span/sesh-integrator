<!-- codex-handoff:managed:start -->

## codex-handoff workflow

For code-changing Codex tasks, use `codex-handoff` from an ordinary checkout.
Unrelated active sessions do not block a new task: create another isolated
source worktree with `codex-handoff begin --create-worktree`. Preserve all user
state, and never reset, clean, discard, or silently stash it.

Continue an existing session only when it belongs to the same task. Otherwise
register with `codex-handoff register --auto-config` when needed and begin a new
session. Perform edits and lifecycle commands from the reported `Continue task
in:` path. Finish with a focused `codex-handoff commit`, then
`codex-handoff validate` and `codex-handoff integrate`. Retry unchanged
validation at most three total attempts when the observed failure is plausibly
retry-safe; stop on repeated or clearly deterministic failure. Resume
recoverable conflicts or pending promotion without destructive cleanup.

Every integration must classify external-state rollout with `--rollout
none|applied|automated|manual`. Manual rollout requires explicit `--follow-up`
actions. Never assume source promotion applied changes in another system.
<!-- codex-handoff:managed:end -->
