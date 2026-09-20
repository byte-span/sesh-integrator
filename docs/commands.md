# Command reference

[Back to the README](../README.md)

Commands below run from the repository root unless stated otherwise.

- [Session task checklists](#session-task-checklists)
- [Finishing without changes](#finishing-without-changes)
- [`dashboard`](#dashboard)
- [`init`](#init)
- [`disable` / `enable`](#disable--enable)
- [`begin`](#begin)
- [Explicit session selection](#explicit-session-selection)
- [`integrate`](#integrate)
- [`resume`](#resume)
- [`status`](#status)
- [Failure incidents](#failure-incidents)
- [`reconcile`](#reconcile)
- [`doctor`](#doctor)

For setup and uninstall, see [installation](installation.md). For `register`,
validation settings, and target branches, see [configuration](configuration.md).

Lifecycle and maintenance commands:

```bash
seshx init
seshx disable [repo-path]
seshx enable [repo-path]
seshx register [repo-path] [--auto-config] [--setup-command '<json-array>']...
seshx begin --summary "Implement feature" [--create-worktree] [--no-auto-branch] [--depends-on <session-id>]...
seshx commit --message "Implement feature" [--session <session-id>]
seshx validate [--session <session-id>]
seshx integrate --summary "Implemented feature and tests" --rollout <none|applied|automated|manual> [--follow-up "..."]... [--session <session-id>]
seshx resume [--session <session-id>]
seshx incident <ticket-id>
seshx status [--session <session-id>]
seshx dashboard
seshx finish --no-changes --summary "..." [--session <session-id>] [--satisfied-by <session-id>]
seshx tasks list [--session <session-id>]
seshx tasks add --title "..." [--title "..."]... [--description "..."] [--session <session-id>]
seshx tasks update <task-id> [--title "..."] [--description "..."] [--status pending|in_progress|completed|blocked|skipped] [--reason "..."] [--session <session-id>]
seshx tasks move <task-id> --position <n> [--session <session-id>]
seshx reconcile [repo-path] [--apply]
seshx audit-legacy
seshx cleanup-guidance [--apply]
seshx doctor
seshx benchmark [--runs <n>] [--json] [--check]
```

There are no `run`, `daemon`, `watch`, or service-management commands.

### Session task checklists

After `begin`, the agent creates an ordered checklist tailored to that session:

```bash
seshx tasks add --title "Inspect existing behavior" --title "Implement changes" --title "Verify and integrate"
seshx tasks update 1 --status in_progress
seshx tasks update 1 --status completed
seshx tasks update 2 --status in_progress
seshx tasks list
```

Tasks default to **pending**. Other statuses are **in_progress**, **completed**,
**blocked**, and **skipped**. Only one task may be in progress per session; finish
or change its status before starting another. Blocked and skipped tasks require
`--reason "..."`. Changing to another status clears the old reason. Task progress
is independent of Git integration status and never substitutes for validation.
Agents explicitly update tasks; the tool does not infer coding activity.

Use `tasks add` for discoveries, `tasks update <id>` to clarify titles or
change descriptions/statuses, and `tasks move <id> --position <n>` to reorder.
IDs remain stable when positions change. Split a task by adding its replacement
steps and skipping the original with a reason. Completed and skipped entries
remain visible; there is no delete/reset operation. Reopen a task by setting it
pending or in progress. Pass an empty description to clear it. A description
on a multi-title add applies to all the new tasks. Never record secret values.

Commands infer the current source session or a single matching session from the
launch checkout. Multiple matches require `--session <session-id>`. Mutations
must run in the session's registered, enabled repository. Updates remain available
after integration so the agent can finish recording its checklist. Explicit
`tasks list --session <id>` works outside the repository and while disabled.
`status --session <id>` also includes the complete checklist.

Checklists are stored in optional `tasks` and `tasksUpdatedAt` fields in
`<runtime>/sessions/<session-id>.json`. Each task records a stable numeric ID,
title, optional description, status, optional reason, and creation/update times.
Existing sessions need no migration and display “No tasks yet” until populated.
Atomic writes and a short per-session record lock serialize checklist edits with
lifecycle saves, preserving task edits made during long-running validation.
Interrupted record locks fail after a bounded wait and report their path for
inspection; they are never silently reclaimed.

The current-task label shows the in-progress task's name, otherwise Not started,
Between tasks, Blocked, All tasks skipped, or Tasks finished. Closed no-change
sessions show No changes needed. Completed/total counts include skipped tasks
in the total and report skipped counts separately in details. A checklist is
complete when every task is completed or skipped; this does not mean integration
or external rollout has completed.

### Finishing without changes

When the requested work is already present, complete or skip every checklist
task, then run `seshx finish --no-changes --summary "Already implemented"`.
Use `--session <id>` to select a session explicitly and optionally
`--satisfied-by <successful-session-id>` to reference the earlier integration.
The CLI verifies that reference belongs to this repository, was successfully
promoted, and its source commit is present in this session's base. It preserves
any recorded PR review and rollout obligations from that integration.

The command requires an unchanged source branch/commit and observable working-tree
baseline, with no integration/recovery state or unfinished checklist tasks. It
records the terminal session status `no_changes`, a finish time, and the reason.
It does not validate, commit, integrate, push, or alter working files. Existing
baseline changes stay untouched. Repeating finish for the same closed session
reports the existing result; further task edits require a new session.

No-change sessions appear under Completed and All, labeled No changes needed,
and disappear from Active. An all-skipped checklist displays `2 skipped`, for
example, rather than `0/2`. Before the session is closed its current-task label
says All tasks skipped; completing/skipping tasks alone does not close a session.
Mixed progress includes its skipped count. Dependencies still require an actual
successful integration; reference the successful session rather than a no-change
inspection session. Old sessions are never silently closed based on task status.

### `dashboard`

#### Local web dashboard

Run `seshx dashboard --web` to start a local web server and open your browser.
It binds to `127.0.0.1` on an available port and prints the URL. No account,
external service, database, or internet connection is required. It shows the
sessions stored on this machine; it does not connect to another computer.

```bash
seshx dashboard --web
seshx dashboard --web --no-open       # Print the URL without opening a browser
seshx dashboard --web --port 4317     # Choose a consistent local port
```

The command stays in the foreground. Ctrl+C or SIGTERM stops it and releases
its file watchers and browser connections. A command started by the dashboard
finishes before shutdown; the terminal explains when it is waiting. Closing a
browser tab leaves the server running until you stop the CLI. Each invocation
starts its own server; a port already in use is reported rather than replaced.

Choose a repository, search sessions, and filter by Active, Needs attention,
Finished, or All sessions. Select a session for its checklist, saved milestones,
source/validation/promotion details, and follow-ups. On smaller screens, use
Back to sessions to return from details. `/` focuses search. The theme follows
your system initially; Light theme / Dark theme saves your browser preference.
Updates preserve selection and detail scroll position. Disconnection and refresh
errors are shown with retry guidance. Status reflects saved records, not agent
process liveness.

The web checklist is read-only: agents maintain its items and statuses through
the CLI. Validate, Integrate, and Resume run the existing CLI in
the selected session's source worktree, using its retained coordinator when
available. Actions require an explicit form submission. Integration collects the
completion summary, rollout classification, and manual follow-ups; the CLI keeps
its normal validation, locking, Git, and PR-promotion safeguards. The web server
rejects stale session/configuration confirmations and permits only one dashboard
command at a time. Resolve and stage conflicts outside the dashboard before
Resume. Browser output shows the most recent 128K characters of command output; normal
CLI evidence remains in the runtime. Closing a tab does not cancel a command.

The server rejects foreign Host/Origin headers and cross-site requests. It has
no remote-listening or tunnel option. If a browser cannot be opened, use the
printed URL on the same machine. Existing terminal dashboard behavior is unchanged.

#### Terminal dashboard

Run `seshx dashboard` in an interactive terminal to browse all
registered repositories and their sessions. The dashboard shows a compact session
table with separate Repository, Session description, Current task, Progress, and
Session status columns. The session description always shows the overall purpose;
Current task shows the current checklist step, and Progress shows completed/total.
Completed sessions show Complete under Current task. Sessions without checklists
show No tasks yet and a dash for progress. Narrow tables use three labeled lines
per session to keep the description, current task, progress, and status readable. The selected-item pane shows the ordered checklist, task
descriptions and blocked/skipped reasons, next-action guidance, saved milestones,
and the full session record. Active is the default filter and includes all
unfinished sessions, including blocked sessions. Completed and All are available
through the status filter. Task updates contribute to sorting and search;
blocked tasks appear in the needs-attention filter. Sessions default to most recent saved event first. Optional priority sorting
puts blockers first, then the latest saved event.
Activity and update times reflect recorded evidence, not a live process monitor.
Wide terminals (at least 111 columns and 20 rows) show the split layout;
smaller terminals use a compact list with full details available through Enter.
At 115 columns and 27 rows, a framed header and main area, a table heading rule,
detail-section dividers, and a separated footer give each section a clear boundary.
Truecolor terminals get a dark navy palette; other terminals use basic ANSI
colors. UTF-8 terminals use a subtle Unicode divider, with ASCII as the fallback.
`NO_COLOR` disables styling. Browsing never writes configuration or session state,
and automatic updates run only while the dashboard is open. It watches session
and configuration directories, batches file events for 150 ms, and refreshes
every 30 seconds as a fallback. Watchers and timers stop when it closes.

Use Up/Down to select, `/` to search task/repository/branch/session text, Left/Right (or `f`) to
cycle status filters, `p` to open the repository picker, and `s` to open the
sort picker (priority, updated, or repository). In either picker, Up/Down moves
the highlight, Enter applies the selection, and Escape cancels. Search applies as you type; Enter finishes and
Escape restores the previous query.
Session ordering follows saved update times; browsing does not read Git.
Automatic updates preserve selection, filters, and detail scroll position.
Updates wait while searching, using a picker, editing a form, confirming an
action, or viewing command output, then resume when browsing resumes. Last refresh shows the exact UTC date/time when
data was loaded and changes only when data is refreshed. Details include the
exact UTC session start time.
Use Tab to switch focus between the session list and selected-item pane.
Up/Down and Page Up/Down move through the focused area; Home/End jump to its
boundaries. The pane keeps its session title and status pinned, with the next
action first and the task checklist after session details. Detail labels are
bold, with aligned values in wide panels and stacked values in narrow panels.
Tasks use Status, #, and Task columns; titles wrap, with muted descriptions and
reasons underneath. Very narrow panels stack each task beneath its status and
number.
A separate footer
labels the visible line range and whether more content is above or below.
Scroll positions are retained per session across selection changes and live
refreshes, and clamped when content shrinks.
Use Enter to expand details, `r` to refresh immediately, and `q` to quit.
In compact terminals, Tab also opens full details; Tab/Escape returns to the list. From either view, `v` validates,
`i` integrates, and `R` resumes a preserved integration (`s` remains a resume
alias in details). Unavailable actions show a reason. Escape returns or cancels
a form. The dashboard requires at least 36 columns and 10 rows; resize the
terminal if prompted. Saved text is shown as terminal-safe ASCII; original
Unicode data remains unchanged.

Actions require confirmation and run the existing CLI in the selected source
worktree with an explicit session ID. Integration collects a completion summary,
one of `none`, `applied`, `automated`, or `manual`, and one or more separate
follow-ups for manual rollout. A ready session retains its saved rollout contract.
Review the confirmation with Up/Down, then press `y` to run. The CLI retains its
normal Git, dependency, validation, recovery, and configured PR-promotion checks.
Changes to saved session/configuration data cancel a stale confirmation.

Command output stays in the normal terminal scrollback. After completion, Enter
returns to refreshed details and `q` quits. Ctrl-C interrupts a running command
using normal terminal signals; inspect its preserved result before retrying.
Resolve and stage conflicts outside the dashboard before choosing Resume.
For redirected output or a noninteractive terminal, use `seshx status`.

### `init`

Creates, without overwriting an existing configuration:

```text
~/.sesh-integrator/
├── config.json
├── state.json
├── codex-home/
├── sessions/
├── indexes/
├── performance/
├── cache/
├── recovery-bundles/
├── recovery-worktrees/
├── incidents/
├── locks/
├── logs/
├── source-worktrees/
└── worktrees/
```

Integration recovery is durable and session-isolated. Before any integration
attempt mutates staging or target refs, the CLI writes a hash-verified manifest
under `recovery-bundles/` and immutable Git refs under
`refs/codex-handoff/recovery/`. Failed attempts remain recoverable even when a
newer session advances staging or the shared integration worktree disappears.
`resume` rebuilds a fresh detached worktree from the bundle and reconciles it
under the repository lock. Bundles are archived only after successful
promotion; failed bundles are not age-cleaned.

Set `PARALLEL_INTEGRATOR_HOME` to use a different runtime root, including in tests.

### `disable` / `enable`

Run `seshx disable` from a repository or any subdirectory to opt it out.
Use `seshx enable` to reverse it. Both accept an optional repository path.
The setting covers all linked worktrees, including repositories that have not
been registered or do not yet have an initial commit. A separate clone has its
own setting.

Opt-outs are stored as canonical Git common-directory paths in the optional
`disabledRepositories` array in the selected runtime's `config.json`:

```json
{ "disabledRepositories": ["/absolute/path/to/project/.git"] }
```

While disabled, `begin`, `commit`, `validate`, `integrate`, `resume`, and
`reconcile --apply` refuse execution. `register` remains available and preserves
the opt-out, including with `--auto-config`; it skips target branch creation
while disabled. Configuration, sessions, branches, and worktrees are retained.
`enable` only clears the opt-out; it does not register or resume the repository.
`status` reports registration and enablement separately; inspection commands
remain available. The workflow skips disabled repositories and uses their normal
development instructions.

Enablement changes refuse an existing integration lock, including an unknown or
stale lock, without removing it. Retry after the integration finishes; inspect
leftover locks manually. Integrations waiting for a lock recheck enablement
before proceeding. Already-running source setup, commit, or validation commands
are not cancelled. Prefer these commands over editing config during execution.

### `begin`

For a Codex CLI task launched from an ordinary checkout, create the session in
a separate source worktree:

```bash
seshx begin --create-worktree --summary "Implement comment editing"
```

The command creates a unique branch and linked worktree below
`~/.sesh-integrator/source-worktrees/`, records the original launch checkout, and
prints `Continue task in: <path>`. Run every edit, `commit`, `validate`,
`integrate`, and `resume` from that printed path. If the current checkout is
already a linked worktree, the flag reuses it. Dirty and staged state in an
ordinary launch checkout is neither moved nor modified.

Starting another `--create-worktree` task from the same ordinary checkout is
allowed while earlier sessions remain active or recoverable. Each task receives
a separate branch and source worktree; only integration and promotion are
serialized by the repository lock.

For deliberate in-place use, omit `--create-worktree`.

`begin` first records an observable Git baseline, then runs centrally configured setup commands and creates a unique
`codex/session-...` branch when the worktree is detached or on the registered
default branch. Failed auto-configured setup warns and continues; failed
explicit setup stops. Existing non-default branches are unchanged.

The baseline stores each status, raw worktree diff, staged raw diff, and index
probe with separate stdout, stderr, and exit status, plus per-path observable
metadata. Pre-existing unstaged changes may remain when they are observably
unchanged and outside the eventual task commit. A tracked path that is already
permission-denied may likewise remain: the CLI warns, preserves it, and makes no
claim about its disk contents. Staged baseline changes are rejected.

Validation, integration, and resume compare the source worktree with that
baseline. A baseline-inaccessible path is allowed only while it remains tracked,
unstaged, outside the task diff, and observably unchanged. New errors, staged
paths, genuine deletions or modifications, and task commits that absorb a
baseline-dirty path still block with a path-specific reason. Setup-created Git
changes are detected because setup runs after baseline capture.

Repeat `--depends-on` for explicit dependencies. Pass `--no-auto-branch` only when strict detached/default-branch rejection is desired. `begin` always rejects unregistered worktrees, staged baseline changes, indeterminate new errors, the integration branch, unknown dependencies, and duplicate active sessions attached to the same source worktree. An active managed session launched from an ordinary checkout does not block another isolated task from that checkout.

`--create-worktree` cannot be combined with `--no-auto-branch`. A failed begin
preserves any newly created source worktree and reports its path rather than
discarding possible setup-created state.

Sessions created by versions that did not record an observable Git baseline
fail validation/integration with a migration message asking you to begin a new
session; they are never silently interpreted using weaker cleanliness rules.

### Explicit session selection

Lifecycle commands continue to infer a session when run in its source worktree.
They may also be run from another checkout of the same repository with
`--session <session-id>`. A shared launch checkout automatically selects its
only matching session; when multiple sessions match, the command lists them and
requires `--session`. `status --session <session-id>` filters the report to one
session.

### `integrate`

After staging only the focused task paths, create the source commit and run
tiered validation:

```bash
seshx commit --message "Implement comment editing"
seshx validate
seshx integrate --summary "Implemented comment editing and tests" --rollout none
```

Every integration must classify external-state rollout as `none`, `applied`,
`automated`, or `manual`. Manual rollout requires at least one explicit
`--follow-up`. This technology-neutral contract covers any change whose effect
depends on another system; promoting source never implies that external state
was applied.

Integration and recovery results print a `Completion summary` containing the session
ID, source commit, staging integration commit, target promotion, pull request
URL when present, and every recorded manual action in full. Retrieve it again
with `seshx status --session <session-id>`. Status also separates current
integration prerequisites from external actions. Successful recovery removes
resolved integration blockers; it does not imply that external setup occurred.
`automated` reports delegation, not verified external completion. Legacy sessions
without rollout metadata report incomplete requirements instead of claiming no
manual work remains.

Use one repeatable `--follow-up` per outstanding action. Specify what to do,
where (system, repository/project, environment), and exact configuration names
verified from non-secret source/configuration. For example:

```text
--follow-up "On a trusted machine, add CWS_CLIENT_ID, CWS_CLIENT_SECRET, and CWS_REFRESH_TOKEN to the release repository's chrome-web-store GitHub environment."
```

Add a separate action listing the verified Actions variable names and their
destination when variables are required; do not guess their names. Credential
values must never enter arguments, session records, or output. Documentation
links supplement known steps rather than replacing them.

The CLI enforces a rollout classification and nonempty manual actions and
preserves their text across retry/recovery. It cannot verify actionability,
external completion, secret-free input, or the agent's final response. The skill
and managed instructions require a final action-by-action check that preserves
destinations and configuration names even when concise. Resolved prerequisites
belong in completed work, not the outstanding list. Recorded follow-ups remain
a declaration snapshot, not an external task tracker: if an action is later
completed with evidence, the agent reports it separately as completed. The CLI
does not infer resolution from error text or remove external steps on recovery.

No session schema migration or new flags are needed; existing `--follow-up`
strings remain supported. After rebuilding the CLI, refresh installed guidance
with `./scripts/install-skill.sh` and `node scripts/sync-managed-guidance.mjs`.
The latter updates only the managed block in global guidance; registered
repositories are not modified. Start a new agent session to load
the updated instructions. Rebuilding suffices for an existing CLI symlink pointing
to this checkout's `dist/cli.js`; other installations must update their CLI too.

The ready SHA and timestamp are persisted before dependency or lock checks. Dependencies must already have succeeded. Simultaneous processes wait on an atomic per-repository directory lock, then merge against the current staging branch. Under that lock the CLI records the target's exact expected commit. The mutable source branch name is never merged.

The staging branch starts from, or safely fast-forwards to, the current target.
After setup, validation, and signing pass, the exact validated staging commit is
promoted. An unheld target uses atomic `update-ref` with the expected old SHA
when no post-integration commands are configured. A target checked out in one clean worktree is
fast-forwarded there and verified so its ref, index, and files remain aligned.
A dirty, inaccessible, divergent, or unexpectedly moved target is never reset:
the session becomes `promotion_pending` and the validated staging commit is
preserved for `resume`.

When the staged integration tree equals the source-validated tree, matching
integration commands reuse their exact-tree results; integration-only commands
still run. Retries reuse successes only while every fingerprint remains exact.

On conflict, `integrate` preserves the merge and saves a contextual prompt under
`~/.sesh-integrator/logs/`. The workflow skill directs the current agent session to
resolve and stage the preserved worktree, then runs `seshx resume` from
the source worktree. `resume` reacquires the repository lock, verifies the exact
source commit, integration HEAD, merge target, branch, and resolved index, then
validates and commits. This default path makes no nested model request.

Set `conflictResolutionMode` to `nested-agent` to invoke the session's recorded
harness for conflict resolution. `nested-codex` remains a compatibility alias
for the same mode. Nested calls require the selected CLI's local authentication
and network access; failure preserves the merge for current-session recovery.

### `resume`

After the workflow has resolved and staged a preserved merge, it runs this from
the original source worktree:

```bash
seshx resume
```

Do not run it from the integration worktree. It resumes only the matching
`needs_review`, `validation_pending`, or `promotion_pending` session and refuses changed source snapshots, mismatched merge
commits, unresolved files, or a moved integration branch. It also retries an
unchanged clean merge after validation or commit creation failed, but only when
the staged tree exactly matches Git's reconstructed merge tree.

For `promotion_pending`, an unchanged target retries the exact validated staging
commit. If the local target advanced normally from the recorded baseline,
`resume` merges that exact target commit with the preserved result in a detached
session-owned recovery worktree under the repository lock. Later staging history
is included when it contains the preserved result. Full integration validation
runs without source-tier cache reuse, then promotion uses the newly observed
expected-old SHA and safely synchronizes the checked-out target. The recorded
ready source and original bundle snapshots remain unchanged.

Local reconciliation performs at most one merge/validation/promotion attempt per
`resume`. Further target movement leaves `promotion_pending`; rerun resume after
reviewing evidence. Rewritten target history or staging history that no longer
contains the result requires ancestry review, not an expected-SHA override.
Conflicts use the saved current-agent prompt: resolve and stage the named worktree,
do not commit, then resume. Failed validation preserves the exact resolved tree
in `validation_pending`, even if that disposable worktree is later lost.
Recovery inputs, resolved trees, validations and results are appended to the
bundle with immutable Git refs. Hash-linked local recovery evidence can repair
an interrupted session-pointer publication; unknown or corrupted evidence stops
recovery. A leftover repository lock still requires safe owner/state inspection.
Post-integration failures remain resumable and rerun their configured checks from
the promoted target worktree.

A validation failure leaves that session's integration worktree intact, records `validation_pending`, releases the one-shot lock, and exits nonzero so the agent can assess the evidence and resume safely. An unresolved conflict records `needs_review`. Later sessions use detached session-owned integration worktrees when the canonical worktree contains preserved review state, and atomically advance staging only after validation. A failed post-integration command also records `needs_review`, but preserves the already-promoted target commit; its command, exit code, stdout, and stderr remain in the session record for diagnosis. If post-integration commands are configured and the target is not checked out in exactly one clean accessible worktree, promotion remains pending. Post-integration commands are skipped when the ready commit was already present and the staging branch did not advance. The source worktree is never modified.

Every integration validation failure records `validation_pending`, including
its command, declared or unclassified status, attempt limit, resource keys, and
failure time. After the agent assesses the preserved evidence, `resume` verifies
the clean merge, reacquires its resources, and retries validation.

### `status`

```bash
seshx status
```

Shows every session, active/ready/waiting/succeeded/`needs_review`/`promotion_pending` state, staging and promoted commits, target branch, recovery phase, worktree paths, latest error, and current lock owners.

### Failure incidents

Failed validation, integration, and resume attempts create immutable incident
tickets under `~/.sesh-integrator/incidents/`. The failure summary prints the
ticket, concise diagnosis, and proposed fix. Inspect its complete stored record
without mutation with:

```bash
seshx incident CH-YYYYMMDD-XXXXXX
```

Instruction or code fixes proposed by an incident are implemented only in a
new, user-approved session. Repeated failure fingerprints provide evidence for
future workflow improvements. Diagnosis is produced by an ephemeral, read-only,
schema-validated agent investigation after releasing the repository lock;
code owns evidence and safety rather than an expanding failure-rule chain. If
that investigation is unavailable or invalid, the ticket records a neutral
fallback instead of guessing. The failed session never edits its own policy.

### `reconcile`

`seshx reconcile` audits registered repositories for historical session
records marked succeeded whose staging commits are absent from the effective
target. It is read-only unless `--apply` is passed. Apply is offered only for a
recorded, ancestry-safe fast-forward whose staging head is an exact successful
integration commit; divergence, staging-behind ambiguity, and unrecorded heads
are refused. Checked-out targets use the same clean-worktree synchronization as
normal promotion. It never merges, resets, deletes, fetches, or pushes.

If a process dies, a same-host dead-PID lock is removed automatically only when the integration worktree is verifiably clean and has no merge in progress. Otherwise the lock and worktree are preserved with manual recovery guidance. A missing owner record or remote-host owner is treated conservatively.

### `doctor`

Run one read-only readiness check from the project you intend to use:

```bash
seshx doctor
```

It checks Node.js, Git, the configured Codex executable, runtime/config files, the installed workflow skill, synchronized managed global guidance without stale concurrency prohibitions, current-project registration, separate staging/target branch ancestry, source and integration validation commands, active locks, and conflicting legacy automation. It prints `READY`, `READY WITH ... WARNINGS`, or `NOT READY` with actionable details. A `NOT READY` result exits nonzero. Warnings cover checks that could not be confirmed safely, such as an unavailable `launchctl` query.
