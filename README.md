# sesh-integrator (`seshx`)

`sesh-integrator` is a personal, one-shot Git integration CLI for Codex CLI, Claude Code, Gemini CLI, and Grok Build sessions working in parallel worktrees. It has no integration daemon, polling service, LaunchAgent, or background queue.

```text
seshx begin
→ create/reuse an isolated source worktree for Codex CLI
→ Codex changes and commits its source branch
→ seshx validate
→ seshx integrate
→ acquire the repository lock
→ merge the exact ready commit in a dedicated integration worktree
→ let the current Codex session resolve conflicts if needed
→ seshx resume
→ validate and commit on the internal staging branch
→ safely promote the exact validated commit to the configured target branch
→ run post-integration checks from that target branch's clean worktree
→ record success, release the lock, and exit
```

The new runtime and internal staging branch are deliberately separate from the legacy daemon:

```text
new: ~/.sesh-integrator/       sesh-integrator/integration
old: ~/.codex-integrator/    codex/integration
```

Use **`seshx`** as the short command. `sesh-integrator`, `pintx`, `parallel-integrator`, and `codex-handoff`
remain supported aliases for the same CLI.

## Requirements and installation

### Renaming an existing installation

The project is now `sesh-integrator`, with `seshx` as its preferred command.
The previous `pintx`, `parallel-integrator`, and `codex-handoff` commands remain aliases.
Rebuild and rerun `./scripts/install-cli.sh` after renaming the checkout.
Keep a symlink at the previous checkout path for existing hooks and scheduled jobs.

Runtime selection uses `SESH_INTEGRATOR_HOME`, `PARALLEL_INTEGRATOR_HOME`, then
`CODEX_HANDOFF_HOME`. Without an override, reuse `~/.codex-handoff/` first, then
`~/.parallel-integrator/` if present; fresh installs use `~/.sesh-integrator/`.
Do not move runtime directories: sessions and Git worktrees contain absolute paths.
Configured integration branches remain unchanged; new registrations default to
`sesh-integrator/integration`. Other `PARALLEL_INTEGRATOR_*` tuning variables
remain supported with their existing names.

The historical `refs/codex-handoff/recovery/` refs, `codex-handoff-session:` PR
markers, and `codex-handoff:managed:` guidance delimiters intentionally remain
stable so recovery, PR ownership checks, and guidance replacement keep working.
These are storage identifiers, not the product name.

After renaming your source folder, rebuild and rerun `scripts/install-cli.sh`
to refresh CLI links. Run `seshx setup` to refresh integrations and explicitly rerun
`scripts/install-machine-safeguards.sh` to refresh hooks and the timer. The safeguard installer disables
the previous health timer before enabling the new one. Existing repository
instructions can continue using the compatibility command until synchronized.

On GitHub, open the repository's **Settings → General**, change **Repository
name** to `sesh-integrator`, and select **Rename**. Then update each clone:

```bash
cd ~/code/sesh-integrator
git remote set-url origin https://github.com/byte-span/sesh-integrator.git
git remote -v
```

See [GitHub's repository rename instructions](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository).

### Developing sesh-integrator concurrently

This repository supports the same isolated sessions, serialized integration, and
agent-assisted conflict recovery as other projects. Use local `dev` as the
target; keep `main` behind the shared `dev` to `main` PR with `scram-j` review.
Local task branches are never published for separate PRs.

Install a validated build as a separate coordinator snapshot before starting
concurrent development. From a clean, validated checkout:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
scripts/install-cli.sh --stable
```

`--stable` copies the built CLI and bundled resources to a new directory under
`~/.local/share/sesh-integrator/releases/` and points the command aliases there.
`SESH_INTEGRATOR_RELEASE_DIR` can override that directory; keep it outside all
source worktrees. Previous releases remain available. Installation without
`--stable` links to the development build and is unsuitable for self-integration.
The installer does not validate the build or refresh skills/hooks automatically.

Pin the real path once per session (record it with your task notes for recovery):

```bash
export SESH_COORDINATOR="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v seshx)")"
node "$SESH_COORDINATOR" status
node "$SESH_COORDINATOR" register --auto-config
```

In the runtime's `config.json` (use the `Runtime:` path from status), set this
repository's `targetBranch` to `dev`. Leave `promotion` unset for local-only
integration; remote pushes require explicit authorization. Auto-configuration
provides dependency setup and validation commands. Then each agent runs:

```bash
node "$SESH_COORDINATOR" begin --create-worktree --harness codex --summary "Task description"
# cd to the printed source worktree and implement the task there.
node "$SESH_COORDINATOR" commit --message "Describe the change"
node "$SESH_COORDINATOR" validate
node "$SESH_COORDINATOR" integrate --summary "Describe the result" --rollout none
```

Maintain the normal session checklist. For conflicts, the current agent resolves
and stages the reported integration worktree, then runs
`node "$SESH_COORDINATOR" resume` from its source worktree. The same coordinator
must handle every lifecycle command; candidate `dist` builds are only for tests.
Dirty files in the launch checkout are preserved and may defer promotion.

Finish all sessions before upgrading the coordinator, particularly when changing
runtime schemas. Install a new validated snapshot, explicitly refresh installed
workflows with its `scripts/install-skill.sh --installed`, and use its path for
new sessions. Retain old snapshots for recovery. Neither merge hooks nor health
checks synchronize `dev` or install candidate builds automatically. The optional
`self-hosting-sync-dev` script is a manual maintenance operation only; do not run
it during active sessions. Existing hook/timer installations should point at the
stable snapshot's scripts; run its
`scripts/install-machine-safeguards.sh --repo /path/to/sesh-integrator` to refresh them.

### macOS upgrade export

The exported `update-sesh-integrator-macos.sh` includes a Git bundle of the validated
local `dev` source, so publishing the rename is not a prerequisite. Copy it to the
Mac and run `bash update-sesh-integrator-macos.sh /path/to/parallel-integrator`.
Use a clean checkout on `dev`, with Git, Node.js 20+, and pnpm installed. The script
refuses divergent history or an occupied destination, fast-forwards from the bundle,
renames the checkout, preserves an old-path symlink, repairs worktree metadata,
updates origin, rebuilds, reinstalls, and runs doctor. It never pushes or advances main.
Network access may be needed for pnpm dependencies. If doctor reports unrelated
runtime issues, the installation remains applied; address the reported issues separately.
The repository script is the export template; it requires an appended bundle payload.

### Install

Requires Node.js 20+ and Git. The npm package includes the built CLI; users do
not need pnpm or a source checkout. Once the package is published to npm:

```bash
npm install -g sesh-integrator
seshx setup
```

`setup` detects `codex`, `claude`, `gemini`, and `grok` executables on `PATH`,
preselects detected harnesses, and lets you choose integrations. It previews the
skill and global instruction paths before confirmation, initializes configuration,
and verifies Git and installed files. Detection does not execute harnesses or
check authentication. Personal instructions outside the managed block are preserved.
Customized skill files are preserved; back them up and move them before reinstalling.
Standard home directories are supported; custom harness homes require manual setup.

For unattended installation, explicitly choose integrations:

```bash
seshx setup --detected --yes
seshx setup --harness claude --harness gemini --yes
```

Then, in your project:

```bash
seshx register --auto-config
seshx doctor --installed
```

To remove installed integrations, run `seshx uninstall` (or `--yes` unattended).
Use `--harness <name>` to remove one integration. Only unchanged managed files and
managed guidance are removed; customized content, configuration, sessions, and
worktrees remain. Empty skill directories may remain. Remove the npm CLI afterward:

```bash
npm uninstall -g sesh-integrator
```

### Install from source

Before npm publication, or for development, use a checkout with pnpm:

```bash
corepack enable
pnpm install
pnpm build
./scripts/install-cli.sh
seshx setup
```

The source installer creates CLI symlinks in `~/.local/bin`; ensure it is on
`PATH`. Set `SESH_INTEGRATOR_BIN_DIR` to choose another user-writable directory.
Neither installation method installs Git hooks or scheduled maintenance.

### Optional maintainer safeguards

For maintainers of this repository only, `./scripts/install-machine-safeguards.sh`
explicitly installs self-hosting Git hooks and a six-hourly Linux systemd health
check. The check can fetch `origin/main` and fast-forward a clean local `dev`.
macOS installs hooks without systemd. These safeguards are separate from public
setup and are not removed by `seshx uninstall`.

`scripts/install-skill.sh` idempotently installs the supplied skill at `~/.agents/skills/sesh-integrator-workflow/`. It accepts an alternate destination for testing:

```bash
./scripts/install-skill.sh /tmp/sesh-integrator-skill
```

Only the managed section in `~/.codex/AGENTS.md` is synchronized, using
[GLOBAL_AGENTS_SNIPPET.md](./GLOBAL_AGENTS_SNIPPET.md). Surrounding global
instructions are preserved. Installation and post-merge hooks never create or
modify `AGENTS.md` in registered repositories, and guidance synchronization does
not require a runtime config. The global policy and installed skill coordinate
the workflow; repository configuration controls validation and promotion.

Project-specific `AGENTS.md` files remain optional and are read during conflict
resolution. Doctor does not require a repository managed block or compare
project instructions with a bundled template. To remove the old generated blocks
from every registered checkout on a machine, run:

```bash
seshx cleanup-guidance --apply
```

Omit `--apply` to preview. The command reads the selected runtime's repository
list, removes recognized `codex-handoff` or `sesh-integrator` managed blocks,
and deletes a file only when nothing but whitespace remains. Text outside the
block is preserved, including line endings. Every changed file is backed up
under `<runtime>/guidance-backups/<id>/AGENTS.md`, with its original path and mode
in `metadata.json`; output prints the backup location.

Cleanup skips staged or unmerged `AGENTS.md` files, symlinks, hard links,
malformed or multiple blocks, and markers inside code examples. It continues
with other repositories and exits nonzero if anything was skipped. Missing
files and files without managed blocks are left alone; repeat runs are safe.
Only registered checkout roots are scanned, not every old linked worktree or
unregistered clone. Register other projects first if they need cleanup.

Cleanup is an explicit local maintenance action, separate from installation and
synchronization. It leaves branches and the Git index unchanged and never
commits, integrates, pushes, or opens PRs. Review tracked-file changes through
your normal workflow. To undo a cleanup, inspect the reported backup and copy
its original file back to the recorded path without overwriting newer edits.

## Commands

These are the complete commands implemented by the MVP:

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

### `register`

Run once for each repository:

```bash
cd ~/Developer/my-project
seshx register
```

Registration records the real Git common directory, branches, and central
setup/validation commands. Re-registering updates requested empty command lists
rather than adding a duplicate.

Pass `--auto-config` to detect setup commands plus safe root `package.json`
validation scripts. It works during initial registration and for an existing
registration:

```bash
seshx register --auto-config
```

Setup detection prefers an executable `scripts/bootstrap`, `scripts/setup`, or `bin/setup`.
Otherwise it recognizes pnpm, Yarn, npm, Bun, uv, Poetry, Cargo, Go modules,
Bundler, Composer, and Mix lockfiles. For JavaScript projects it also detects
`format:check`, `typecheck`, `lint`, and `test` for source validation, then adds
`build` for integration validation. It ignores scripts such as end-to-end
tests, deployment, and release commands. Existing non-empty command lists are
never replaced.

Repositories can opt into explicit aggregate scripts. `handoff:source` and
`handoff:integration` override the detected validation lists, while
`handoff:post-integration` is the only package script automatically selected
for post-integration work:

```json
{
  "scripts": {
    "handoff:source": "pnpm format:check && pnpm typecheck && pnpm test",
    "handoff:integration": "pnpm handoff:source && pnpm build",
    "handoff:post-integration": "node scripts/notify-integration.mjs"
  }
}
```

Auto-configuration never executes the detected scripts. It only writes their
argument arrays to `~/.sesh-integrator/config.json`. If no supported scripts are
found, registration still succeeds and reports that the command lists remain
unconfigured.

For an unknown ecosystem, provide one or more argument arrays once during
registration:

```bash
seshx register --setup-command '["make","bootstrap"]'
```

Edit `~/.sesh-integrator/config.json` to add validation and conflict settings. Commands are argument arrays and are never passed through a shell:

```json
{
  "lockWaitSeconds": 900,
  "codexCommand": "codex",
  "conflictResolutionMode": "current-session",
  "defaultPromotion": {
    "reviewers": ["scram-j"],
    "assignees": ["scram-j"]
  },
  "repositories": [
    {
      "path": "/Users/you/Developer/my-project",
      "gitCommonDir": "/Users/you/Developer/my-project/.git",
      "defaultBranch": "main",
      "integrationBranch": "sesh-integrator/integration",
      "targetBranch": "main",
      "promotion": { "type": "none" },
      "gpgProgram": "/Users/you/.local/bin/codex-gpg",
      "setupCommands": [["corepack", "pnpm", "install", "--frozen-lockfile"]],
      "setupCommandPolicy": "advisory",
      "validationCache": "session",
      "sourceValidationCommands": [
        {
          "parallel": [
            ["pnpm", "typecheck"],
            ["pnpm", "test"]
          ]
        }
      ],
      "integrationValidationCommands": [
        ["pnpm", "typecheck"],
        ["pnpm", "test"],
        ["pnpm", "build"]
      ],
      "validationTiers": [
        {
          "name": "docs",
          "paths": ["**/*.md", "**/*.mdx", "LICENSE*", "NOTICE*"],
          "sourceValidationCommands": [],
          "integrationValidationCommands": [],
          "bypassIntegrationWorktree": true
        }
      ],
      "postIntegrationCommands": [],
      "conflictInstructions": "Preserve compatible intent and follow repository AGENTS.md."
    }
  ]
}
```

`integrationBranch` is internal staging. `targetBranch` is the final local
destination and may be omitted; omission is backward compatible and resolves
to the registered `defaultBranch`. Existing `integrationBranch` values keep
their staging meaning. An explicit `targetBranch` equal to `integrationBranch`
is supported as a legacy-style opt-in, but then there is no separate final ref
and that branch cannot already be checked out in another worktree. No branch is
pushed unless pull-request promotion is explicitly configured.

### Optional pull-request promotion

Remote promotion is disabled by default. To turn a successful local `dev`
handoff into a review-ready `dev` to `main` PR, configure:

```json
{
  "targetBranch": "dev",
  "promotion": {
    "type": "pull-request",
    "productionBranch": "main",
    "remote": "origin",
    "reviewers": ["platform-team"],
    "assignees": ["release-owner"]
  }
}
```

After local promotion and post-integration checks pass, `sesh-integrator` performs
a normal non-force push, reuses an existing open PR for the same branch pair or
creates a ready-for-review PR, requests configured reviewers, and adds configured
assignees. Omit
`productionBranch` to use `defaultBranch`, omit `remote` to use `origin`, and
omit `reviewers` when CODEOWNERS or another GitHub policy assigns reviewers.
The remote step requires authenticated `git` and `gh` access. Failures remain
resumable with `seshx resume`.

In shared-target mode, a non-fast-forward push caused by an advanced remote
target is recovered automatically. The tool fetches the exact remote target,
merges it into the validated staging integration, runs full integration
validation and post-integration checks again, promotes the rebuilt commit
locally, and retries the normal push. Recovery is limited to three attempts.
Conflicts are preserved for `seshx resume`; validation failures,
ambiguous ancestry, and continued remote movement stop safely. The fetched
commit and attempt count are persisted so interrupted recovery is resumable.

The shared target is fetched while holding the repository integration lock,
immediately before the integration baseline is recorded. A normal remote
fast-forward is incorporated into that baseline. If the remote moves again,
the exact combined result is rebuilt and fully revalidated before each bounded
non-force push retry. A remote tip that is not descended from the locked
baseline is treated as replaced history and stops with a diagnostic; the tool
never force-pushes through it.

Protect shared target branches on the hosting provider: prohibit force pushes
and branch deletion, and require updates to remain fast-forward-compatible.
These settings are part of the reliability contract for automatic shared-target
promotion; rewritten history always requires manual inspection.

This is the backward-compatible shared-target mode. Its explicit spelling is
`"mode": "shared-target"`; omitting `mode` behaves identically.

For an independent PR for every completed session, configure
`"mode": "session-branch"`. That mode pushes the exact recorded source commit
to the session's source branch and opens a PR from it to the production branch.
Multiple session PRs may remain open concurrently. A retry reuses only an open
PR whose head and embedded session marker belong to that same session, and
never edits another session's PR.

```json
{
  "targetBranch": "dev",
  "promotion": {
    "type": "pull-request",
    "mode": "session-branch",
    "productionBranch": "main",
    "remote": "origin",
    "reviewers": ["platform-team"],
    "assignees": ["release-owner"]
  }
}
```

Both modes use normal non-force pushes and never merge, close, delete, or
force-update remote branches or PRs. Before pushing, the tool validates branch
names, the configured remote, `gh` authentication, remote base existence, and
that base and head commits differ. `status` reports the mode and saved PR URL;
`doctor` checks remote-promotion readiness.

To apply participants to every repository that already uses pull-request
promotion, set global defaults once:

```json
{
  "defaultPromotion": {
    "reviewers": ["scram-j"],
    "assignees": ["scram-j"]
  }
}
```

Per-repository `reviewers` and `assignees` override their corresponding global
lists. Set either repository list to `[]` to disable that default for one
repository. These defaults do not enable remote promotion by themselves.

### Stable default branch with a development target

Some repositories keep `main` as the default and stable branch while agents
work on `dev`. For that workflow, keep the detected `defaultBranch` unchanged
and set an explicit target in `~/.sesh-integrator/config.json`:

```json
{
  "defaultBranch": "main",
  "integrationBranch": "sesh-integrator/integration",
  "targetBranch": "dev"
}
```

This makes successful handoffs promote locally to `dev`; it does not merge or
push `main`. A separate trusted review workflow can then promote `dev` to
`main`. Apply the same setting to repositories registered before adopting this
branch policy: if `targetBranch` is omitted, it still resolves to `main`.

An explicit per-repository target must already exist locally. For example,
track an existing remote branch or create it from `main` before beginning a
handoff:

```bash
git switch --track origin/dev 2>/dev/null || git switch -c dev main
```

#### Automatic global policy

Set the global `defaultTargetBranch` to make the same policy automatic for both
existing and newly registered repositories. With
`"defaultTargetBranch": "dev"`, target resolution will use this precedence:

1. an explicit repository `targetBranch` override
2. the global `defaultTargetBranch`
3. the repository `defaultBranch`

Changing the global default will immediately affect existing registrations
that omit `targetBranch`; it will not overwrite explicit repository overrides.
Registration and pre-session checks reuse a local `dev`, track
`origin/dev` when available, or create local `dev` from the registered default
branch. They must not switch the user's checkout or create a target from an
unborn default branch. No target branch is pushed automatically.

An older entry that omits `targetBranch` while setting `integrationBranch`
equal to `defaultBranch` or the effective global target is rejected as
ambiguous instead of being silently migrated. Review its history, then
configure a separate staging branch or make the combined target choice
explicit.

`gpgProgram` is optional. When set, `sesh-integrator` applies it only to its
controlled source and integration commit commands. When signing is enabled,
the CLI performs a real in-memory OpenPGP signing preflight immediately before
each commit and refuses to invoke Git if the agent, key, pinentry, or program is
unavailable. Direct-integration merge commits are signed when the effective
`commit.gpgSign` setting is enabled.

Auto-configured setup is `advisory` during `begin`: failure prints a warning but
does not block branch or session creation. Explicit `--setup-command` setup is
`required` and still blocks `begin` on failure. Integration normally requires
successful setup before its selected validation commands. The workflow skill
commits the focused change, then runs `seshx validate` against that exact
commit. After the staging branch advances, the CLI promotes the validated
commit and runs `postIntegrationCommands` from the clean worktree checking out
the target branch. Configuring these commands therefore requires exactly one
accessible, clean target checkout. All commands are argument arrays executed
directly without a shell.

Before any non-empty validation plan, `sesh-integrator` infers safe disposable
framework preparation directly from package manifests, including packages
nested in a monorepo. It currently recognizes Next.js type generation,
SvelteKit sync, Nuxt prepare, Astro sync, and React Router type generation. It
skips preparation already present in a package script and does not infer
deployment, migration, release, or source-rewriting generators. These defaults
apply to existing registrations without additional configuration.

Validation tiers are evaluated in configuration order. A tier matches only when
every changed path matches at least one of its glob patterns; otherwise the
legacy source/integration lists form the `full` tier. `--auto-config` adds a
documentation-only tier. Re-run registration with `--auto-config` to add it to
an existing repository with no tiers configured.

An explicitly configured tier may set `bypassIntegrationWorktree` to `true`.
The bypass is used only for the exact commit previously checked by
`seshx validate`, and only when the tier has no integration commands and
the repository has no post-integration commands. Under the repository lock, the
CLI uses Git plumbing and atomically advances the staging ref, then promotes
through the normal checked-target safety path. Conflicts or
unsupported Git fall back to the normal integration worktree. A clean,
tool-owned integration worktree may be removed before this update; user
worktrees are never removed.

Validation command lists also accept explicit `{ "parallel": [...] }` groups.
Commands within a group run concurrently; groups and ordinary commands still
run in order and any failed member stops validation. Auto-configuration groups
independent inferred checks and adds documentation-only and test-only tiers.

Commands that share finite infrastructure can declare opaque resource keys and
failure behavior without naming a framework or service in sesh-integrator:

```json
{
  "command": ["tool", "check"],
  "resources": {
    "shared": ["environment:read"],
    "exclusive": ["fixture:mutable"]
  },
  "failure": {
    "classification": "transient",
    "maxAttempts": 3,
    "initialBackoffMs": 250,
    "maxBackoffMs": 2000
  }
}
```

Shared holders may overlap; exclusive holders serialize with both shared and
exclusive holders for the same key, including validations in other repositories
and sessions. Multiple keys are acquired in sorted order. Unrelated keys remain
concurrent. Commands default to an unclassified, resumable failure after one
attempt. A non-zero exit is evidence, not a deterministic verdict. A command
declared transient uses bounded exponential backoff; omitted retry values
default to three attempts, 250 ms initial backoff, and a 2 s cap. Legacy
`deterministic` declarations are accepted but treated as unclassified.

`validationCache` defaults to `session`: successful commands are reusable only
for the same Git tree, command fingerprint, platform, architecture, and Node
version in that handoff. Set it to `repository` for content-addressed reuse
across sessions, or `off` to disable reuse. Auto-detected advisory JavaScript
setup is skipped only when its manifest/lockfile fingerprint matches and the
worktree still has its dependency marker. Explicit required setup is never
skipped.

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

For `promotion_pending`, `resume` retries only the recorded validated staging
commit against the recorded expected target SHA. It does not rebuild from a
source branch that may have advanced. Post-integration failures are likewise
resumable and rerun their configured checks from the promoted target worktree.

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

## Disposable-repository verification

The Vitest suite creates only disposable temporary Git repositories and uses fake Codex executables for deterministic conflicts:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark:check
```

It proves begin metadata, exact clean merges, simultaneous serialization, refreshed integration state, contextual conflict resolution, non-precedence of start time, dependencies, validation failure, unresolved conflicts, untouched source worktrees, conservative stale-lock behavior, read-only legacy audit, and both successful and failing read-only doctor checks.

### Performance reporting and benchmarks

Lifecycle commands print total time plus their slowest phases and persist one
aggregate JSON record per session under `~/.sesh-integrator/performance/`.
Records separate setup, source validation, lock wait, worktree preparation,
merge, integration validation, commit, promotion, and post-integration timing;
they also include subprocess counts, validation tier, changed-path count, and
cache hits.

`seshx benchmark` creates disposable small, large, dirty, conflicting,
and concurrent repositories and reports median, p95, and maximum tool/Git
overhead separately from user-configured commands. `--check` enforces CI
regression budgets. `PARALLEL_INTEGRATOR_BENCHMARK_BUDGET_SCALE` scales them for a
consistently slower runner.

Benchmark cleanup retries transient filesystem errors up to three attempts.
Set `SESH_INTEGRATOR_BENCHMARK_DIAGNOSTICS_DIR` to a directory outside the
benchmark fixture to capture each failed attempt: up to 200 remaining path
names/types and Git/Node process IDs and executable names. File contents,
process arguments, and environment values are excluded. CI uploads these
snapshots alongside Git traces from three separate macOS benchmark runs as
`benchmark-diagnostics-macos-latest-node-<version>` artifacts, retained for
seven days. Snapshots are captured even when a later cleanup retry succeeds;
repeated cleanup failure still fails the benchmark.

### Real macOS signing reliability

Install current native Homebrew GnuPG and pinentry, then run the idempotent host
installer outside a Codex sandbox:

```bash
/opt/homebrew/bin/brew install gnupg pinentry-mac
./scripts/install-gpg-reliability.sh
```

The installer backs up Git/GPG configuration (never private keys), selects
`/opt/homebrew/opt/gnupg`, installs a keepalive user LaunchAgent for the
canonical `~/.gnupg` agent, disables only MacGPG's competing agent-shutdown
job, and installs `~/.local/bin/codex-gpg`. The wrapper checks the agent with
autostart disabled, asks launchd to recover it, retries for five seconds, and
fails with an actionable diagnostic. It rejects any private material in
`~/.codex-gpg/private-keys-v1.d`.

The real test is deliberately opt-in because it invokes the real signing key
and pinentry, kills the agent, and may display a pinentry prompt:

```bash
PARALLEL_INTEGRATOR_REAL_GPG_E2E=1 ./scripts/test-real-gpg-e2e.sh initial
PARALLEL_INTEGRATOR_REAL_GPG_E2E=1 ./scripts/test-real-gpg-e2e.sh after-wake
PARALLEL_INTEGRATOR_REAL_GPG_E2E=1 ./scripts/test-real-gpg-e2e.sh after-fresh-login
```

It uses `sandbox-exec` to deny writes to `~/.gnupg`, creates signed source and
integration commits through `sesh-integrator`, verifies both with Git, checks the
bridge and disposable repository for private-key directories, prints exact
versions/paths/commits, and retains the disposable evidence directory.

A manual clean-merge trial can also be run:

```bash
trial_dir=$(mktemp -d)
git init -b main "$trial_dir/repo"
git -C "$trial_dir/repo" config user.name "Handoff Test"
git -C "$trial_dir/repo" config user.email "handoff@example.com"
touch "$trial_dir/repo/base.txt"
git -C "$trial_dir/repo" add base.txt
git -C "$trial_dir/repo" commit -m base
seshx register "$trial_dir/repo"
git -C "$trial_dir/repo" worktree add -b codex/demo "$trial_dir/demo" main
cd "$trial_dir/demo"
seshx begin --summary "Disposable demo"
echo demo > demo.txt
git add demo.txt
seshx commit --message "Add demo"
seshx validate
seshx integrate --summary "Added disposable demo" --rollout none
git -C "$trial_dir/repo" log --oneline --graph sesh-integrator/integration
git -C "$trial_dir/repo" log --oneline --graph main
```

## Auditing and disabling the old daemon

First run the read-only audit:

```bash
seshx audit-legacy
```

It reports `FOUND`, `NOT FOUND`, or `UNKNOWN` for the old source/runtime, skill, global instructions, Codex config, likely LaunchAgent, loaded launchctl jobs, registered-repository hooks, and old integration branches/worktrees. It changes none of them.

The legacy project's current documented macOS commands are:

```bash
codex-integrator daemon status
codex-integrator daemon stop
codex-integrator daemon uninstall
```

Run those only after the disposable test passes. Then review and disable the old `~/.agents/skills/codex-integrator-workflow`, remove only legacy `codex-integrator` guidance from `~/.codex/AGENTS.md`, and inspect each repository's `core.hooksPath` and hook files. Do not delete the old source, state, worktrees, or `codex/integration` branch during the initial trial.

For rollback, stop invoking the new skill, restore the previous global guidance, re-enable the old skill, and restart the old daemon using its own documented command. The separate state directories and integration branches make that reversible.

## Known limitations

- Skill invocation remains instruction-driven. Source commit creation itself is
  controlled by `seshx commit`; a crashed Codex session must still be
  resumed manually.
- A running Codex CLI process cannot change its parent shell directory. The
  agent must honor the `Continue task in:` path for all subsequent tool calls.
- Managed source worktrees are retained after completion; cleanup is currently
  manual and must not remove a worktree containing uncommitted state.
- The tool fetches only an explicitly configured shared target during bounded
  non-fast-forward recovery. It never force-pushes, deletes branches, or
  merges/resets user worktrees. It pushes only when a repository explicitly
  enables pull-request promotion.
- A preserved session whose staging baseline is overtaken by a later successful integration requires reconciliation before that older session can promote its validated result.
- Dependency checks fail clearly rather than running a background waiter; retry after dependencies succeed.
- The current-session resolution path is instruction-driven; genuinely ambiguous conflicts or failed validation still require user review.
- Optional nested conflict resolution requires a compatible authenticated harness CLI. `harnessCommands` values are executable paths, not shell commands.
- Stale-lock recovery is intentionally narrow. Ambiguous, dirty, unfinished, missing-metadata, or other-host cases require manual inspection.
- JSON state is designed for a personal local tool, not distributed or multi-host coordination.

## Additional coding harnesses

Install the shared workflow and global instructions for each harness you use:

```bash
seshx setup --harness claude
seshx setup --harness gemini
seshx setup --harness grok
```

Setup preserves personal text outside the managed instruction block and leaves
repository instructions untouched. The legacy `scripts/install-skill.sh` keeps
its no-argument Codex default and positional custom skill directory support.

| Harness                       | Identifier | User skill directory | Global instructions   |
| ----------------------------- | ---------- | -------------------- | --------------------- |
| Codex CLI                     | `codex`    | `~/.agents/skills/`  | `~/.codex/AGENTS.md`  |
| Claude Code                   | `claude`   | `~/.claude/skills/`  | `~/.claude/CLAUDE.md` |
| Gemini CLI                    | `gemini`   | `~/.gemini/skills/`  | `~/.gemini/GEMINI.md` |
| Grok Build (official xAI CLI) | `grok`     | `~/.grok/skills/`    | `~/.grok/AGENTS.md`   |

Each skill directory contains `sesh-integrator-workflow/SKILL.md`. These commands
use the standard user directories under HOME. Custom harness home directories
require installing the skill and global instructions at the corresponding custom
paths yourself; doctor checks the standard paths.

```bash
seshx doctor --harness claude
seshx begin --harness claude --create-worktree --summary "Implement the change"
```

Substitute `gemini` or `grok` as appropriate. Session status records the harness;
old sessions and omitted flags retain Codex behavior. All four use the same
commit, validation, integration, checklist, and recovery commands. Conflicts are
resolved by the active agent, followed by `seshx resume`. Claude and Gemini project
instructions are included alongside `AGENTS.md` in saved conflict context.

All harnesses support current-session recovery, optional nested resolution, and
automated incident diagnosis. One runner owns time limits, prompt delivery, error
handling, and response decoding; shared incident validation rejects malformed
results and preserves a neutral fallback. Nested agents edit conflict contents; seshx verifies the integration HEAD and
checks for leftover markers before staging the original conflicted paths. All
Git checks remain in the shared lifecycle. Tests use fake CLIs and disposable repositories; live authenticated
agent behavior is not covered by automated tests.

### Shared harness configuration and maintenance

`harnesses.json` is the single registry of harness names, installation paths, and
native skill metadata. Both the CLI and installation scripts consume it.

```json
{
  "conflictResolutionMode": "nested-agent",
  "harnessCommands": {
    "codex": "codex",
    "claude": "claude",
    "gemini": "gemini",
    "grok": "grok"
  }
}
```

These optional fields belong in the existing global config. Executables default
to the harness identifier. `codexCommand` remains a legacy fallback for Codex;
`harnessCommands.codex` takes precedence. Current-session remains the default.

`scripts/install-skill.sh --installed` refreshes all installed workflows and their
global instructions. The machine safeguard installer uses it; post-merge hooks
do not refresh workflows or global instructions.
`seshx doctor --installed` checks those same installations and reports failure if
any fails. Scheduled health checks and macOS upgrade checks use this mode.
An installed workflow is identified by its native `sesh-integrator-workflow/SKILL.md`;
unused harnesses are not installed by bulk refresh or machine safeguards. On a
fresh installation, run `seshx setup` or choose a harness with `seshx setup --harness <name>`
before running the health check. The no-argument Codex default
and positional custom-directory installer remain compatible.

### Documented adapter differences

- Codex supports schema/output files and sandbox modes; its existing isolated
  `CODEX_HOME` handling remains internal to that adapter.
- Claude uses print-mode JSON and native structured output, restricted tools,
  and plan/acceptEdits permissions. Bare mode disables automatic plugin/hook discovery.
- Gemini returns JSON containing a response string. A per-call policy restricts
  diagnosis to read tools and resolution to reading and editing.
- Grok uses a prompt file, JSON containing `text`, native read-only/workspace
  sandbox profiles, and tool/permission filters. Automatic updates are disabled
  for these one-shot calls.

CLI permission/sandbox guarantees differ and can be constrained by managed
policy. No adapter requests a blanket permission bypass. Unsupported flags,
missing authentication, rejected tools, and invalid diagnoses fail safely;
update the CLI or continue recovery in the current session. Gemini/Grok diagnoses
are validated locally against the same required fields as native structured outputs.

The legacy audit still targets the historical `codex-integrator` daemon because
that is the legacy system being detected; it is available from every harness.

References: [Claude skills](https://code.claude.com/docs/en/skills),
[Gemini skills](https://geminicli.com/docs/cli/using-agent-skills/),
[Grok skills](https://docs.x.ai/build/features/skills-plugins-marketplaces),
[Grok global rules](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md).

Execution references: [Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Gemini headless output](https://geminicli.com/docs/cli/headless/),
[Gemini policy engine](https://geminicli.com/docs/reference/policy-engine/),
[Grok headless flags and output](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md),
[Grok sandbox profiles](https://docs.x.ai/build/features/sandbox).
