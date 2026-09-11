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
`codex-handoff validate` and `codex-handoff integrate`. Treat failure output as
evidence, not a verdict about determinism. Retry unchanged validation or resume
pending integration in the same session at most three total attempts when safe;
stop on repeated failure or evidence of a code defect. Resume recoverable
conflicts or pending promotion without destructive cleanup.

Every integration must classify external-state rollout with `--rollout
none|applied|automated|manual`. Manual rollout requires explicit `--follow-up`
actions. Never assume source promotion applied changes in another system.

Report the session, source commit, staging integration commit, target branch and
promoted commit, and pull-request URL when present.

For each `--follow-up`, record one actionable outstanding step: what to do,
where to do it (system, repository/project, environment), and exact configuration
names when known. Verify names from non-secret source/configuration; do not
invent missing names. For credentials, record only names and destination and
say to configure them on a trusted machine. Never request, read, store, or print
secret values, including in CLI arguments or session records.

Before the final response, use the latest `Completion summary` (available again
with `codex-handoff status --session <session-id>`) and check every recorded
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
<!-- codex-handoff:managed:end -->
