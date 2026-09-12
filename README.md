# parallel-integrator

`parallel-integrator` is a personal, one-shot Git integration CLI for Codex sessions working in parallel worktrees. It has no daemon, watcher, polling service, LaunchAgent, or background queue.

```text
parallel-integrator begin
→ create/reuse an isolated source worktree for Codex CLI
→ Codex changes and commits its source branch
→ parallel-integrator validate
→ parallel-integrator integrate
→ acquire the repository lock
→ merge the exact ready commit in a dedicated integration worktree
→ let the current Codex session resolve conflicts if needed
→ parallel-integrator resume
→ validate and commit on the internal staging branch
→ safely promote the exact validated commit to the configured target branch
→ run post-integration checks from that target branch's clean worktree
→ record success, release the lock, and exit
```

The new runtime and internal staging branch are deliberately separate from the legacy daemon:

```text
new: ~/.parallel-integrator/       parallel-integrator/integration
old: ~/.codex-integrator/    codex/integration
```

## Requirements and installation

### Renaming an existing installation

This project was previously named `codex-handoff`. The package, primary CLI,
source folder, bundled skill, and health timer are now named
`parallel-integrator`. The installer also supplies `codex-handoff` as a
compatibility command for existing scripts and guidance.

Runtime selection uses `PARALLEL_INTEGRATOR_HOME`, then the compatibility
`CODEX_HANDOFF_HOME` variable. Without either override, an existing
`~/.codex-handoff/` directory is reused in place; fresh installations use
`~/.parallel-integrator/`. Existing installations therefore continue editing
their existing `~/.codex-handoff/config.json`. Do not move active runtime
directories: sessions and Git worktrees contain absolute paths. Configured
integration branches remain unchanged; new registrations default to
`parallel-integrator/integration`.

The historical `refs/codex-handoff/recovery/` refs, `codex-handoff-session:` PR
markers, and `codex-handoff:managed:` guidance delimiters intentionally remain
stable so recovery, PR ownership checks, and guidance replacement keep working.
These are storage identifiers, not the product name.

After renaming your source folder, rebuild and rerun `scripts/install-cli.sh`
to refresh CLI links, hooks, the skill, and the timer. The installer disables
the previous health timer before enabling the new one. Existing repository
instructions can continue using the compatibility command until synchronized.

On GitHub, open the repository's **Settings → General**, change **Repository
name** to `parallel-integrator`, and select **Rename**. Then update each clone:

```bash
cd ~/code/parallel-integrator
git remote set-url origin https://github.com/Run-It-Back-Group/parallel-integrator.git
git remote -v
```

See [GitHub's repository rename instructions](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository).

### Install

- Node.js 20 or newer
- Git
- pnpm
- the `codex` executable only when legacy nested conflict resolution is enabled

From this repository:

```bash
corepack enable
pnpm install
pnpm build
./scripts/install-cli.sh
parallel-integrator init
```

The CLI installer creates an idempotent symlink in `~/.local/bin`, which must be on `PATH`. Set `PARALLEL_INTEGRATOR_BIN_DIR` to choose another user-writable bin directory. It also installs the machine safeguards: the bundled skill, global managed guidance, conservative self-hosting Git hooks, and a bounded six-hourly user systemd health check. The health check safely fetches `origin/main` and fast-forwards a clean local `dev` after a remote dev-to-main merge; dirty or divergent state is reported and preserved.

`scripts/install-skill.sh` idempotently installs the supplied skill at `~/.agents/skills/parallel-integrator-workflow/`. It accepts an alternate destination for testing:

```bash
./scripts/install-skill.sh /tmp/parallel-integrator-skill
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
parallel-integrator cleanup-guidance --apply
```

Omit `--apply` to preview. The command reads the selected runtime's repository
list, removes recognized `codex-handoff` or `parallel-integrator` managed blocks,
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
parallel-integrator init
parallel-integrator register [repo-path] [--auto-config] [--setup-command '<json-array>']...
parallel-integrator begin --summary "Implement feature" [--create-worktree] [--no-auto-branch] [--depends-on <session-id>]...
parallel-integrator commit --message "Implement feature" [--session <session-id>]
parallel-integrator validate [--session <session-id>]
parallel-integrator integrate --summary "Implemented feature and tests" --rollout <none|applied|automated|manual> [--follow-up "..."]... [--session <session-id>]
parallel-integrator resume [--session <session-id>]
parallel-integrator incident <ticket-id>
parallel-integrator status [--session <session-id>]
parallel-integrator dashboard
parallel-integrator reconcile [repo-path] [--apply]
parallel-integrator audit-legacy
parallel-integrator cleanup-guidance [--apply]
parallel-integrator doctor
parallel-integrator benchmark [--runs <n>] [--json] [--check]
```

There are no `run`, `daemon`, `watch`, or service-management commands.

### `dashboard`

Run `parallel-integrator dashboard` in an interactive terminal to browse all
registered repositories and their sessions. Sessions appear newest first by start
time across all repositories; repositories without sessions appear at the bottom.
Browsing uses the existing runtime
without writing configuration or session state. There is no automatic polling.

Use Up/Down to select a session, Enter for details, `r` to refresh, and `q` to
quit. In details, Up/Down scrolls the complete record, including long follow-ups;
`v` validates, `i` integrates, and `s` resumes a preserved integration. Unavailable
actions show a reason. Escape returns or cancels a form. The dashboard requires
at least 36 columns and 10 rows; resize the terminal if prompted. Saved text is
shown as terminal-safe ASCII; original Unicode data remains unchanged.

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
For redirected output or a noninteractive terminal, use `parallel-integrator status`.

### `init`

Creates, without overwriting an existing configuration:

```text
~/.parallel-integrator/
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

### `register`

Run once for each repository:

```bash
cd ~/Developer/my-project
parallel-integrator register
```

Registration records the real Git common directory, branches, and central
setup/validation commands. Re-registering updates requested empty command lists
rather than adding a duplicate.

Pass `--auto-config` to detect setup commands plus safe root `package.json`
validation scripts. It works during initial registration and for an existing
registration:

```bash
parallel-integrator register --auto-config
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
argument arrays to `~/.parallel-integrator/config.json`. If no supported scripts are
found, registration still succeeds and reports that the command lists remain
unconfigured.

For an unknown ecosystem, provide one or more argument arrays once during
registration:

```bash
parallel-integrator register --setup-command '["make","bootstrap"]'
```

Edit `~/.parallel-integrator/config.json` to add validation and conflict settings. Commands are argument arrays and are never passed through a shell:

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
      "integrationBranch": "parallel-integrator/integration",
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

After local promotion and post-integration checks pass, `parallel-integrator` performs
a normal non-force push, reuses an existing open PR for the same branch pair or
creates a ready-for-review PR, requests configured reviewers, and adds configured
assignees. Omit
`productionBranch` to use `defaultBranch`, omit `remote` to use `origin`, and
omit `reviewers` when CODEOWNERS or another GitHub policy assigns reviewers.
The remote step requires authenticated `git` and `gh` access. Failures remain
resumable with `parallel-integrator resume`.

In shared-target mode, a non-fast-forward push caused by an advanced remote
target is recovered automatically. The tool fetches the exact remote target,
merges it into the validated staging integration, runs full integration
validation and post-integration checks again, promotes the rebuilt commit
locally, and retries the normal push. Recovery is limited to three attempts.
Conflicts are preserved for `parallel-integrator resume`; validation failures,
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
and set an explicit target in `~/.parallel-integrator/config.json`:

```json
{
  "defaultBranch": "main",
  "integrationBranch": "parallel-integrator/integration",
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

`gpgProgram` is optional. When set, `parallel-integrator` applies it only to its
controlled source and integration commit commands. When signing is enabled,
the CLI performs a real in-memory OpenPGP signing preflight immediately before
each commit and refuses to invoke Git if the agent, key, pinentry, or program is
unavailable. Direct-integration merge commits are signed when the effective
`commit.gpgSign` setting is enabled.

Auto-configured setup is `advisory` during `begin`: failure prints a warning but
does not block branch or session creation. Explicit `--setup-command` setup is
`required` and still blocks `begin` on failure. Integration normally requires
successful setup before its selected validation commands. The workflow skill
commits the focused change, then runs `parallel-integrator validate` against that exact
commit. After the staging branch advances, the CLI promotes the validated
commit and runs `postIntegrationCommands` from the clean worktree checking out
the target branch. Configuring these commands therefore requires exactly one
accessible, clean target checkout. All commands are argument arrays executed
directly without a shell.

Before any non-empty validation plan, `parallel-integrator` infers safe disposable
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
`parallel-integrator validate`, and only when the tier has no integration commands and
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
failure behavior without naming a framework or service in parallel-integrator:

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
parallel-integrator begin --create-worktree --summary "Implement comment editing"
```

The command creates a unique branch and linked worktree below
`~/.parallel-integrator/source-worktrees/`, records the original launch checkout, and
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
parallel-integrator commit --message "Implement comment editing"
parallel-integrator validate
parallel-integrator integrate --summary "Implemented comment editing and tests" --rollout none
```

Every integration must classify external-state rollout as `none`, `applied`,
`automated`, or `manual`. Manual rollout requires at least one explicit
`--follow-up`. This technology-neutral contract covers any change whose effect
depends on another system; promoting source never implies that external state
was applied.

Integration and recovery results print a `Completion summary` containing the session
ID, source commit, staging integration commit, target promotion, pull request
URL when present, and every recorded manual action in full. Retrieve it again
with `parallel-integrator status --session <session-id>`. Status also separates current
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
`~/.parallel-integrator/logs/`. The workflow skill directs the current Codex session to
resolve and stage the preserved worktree, then runs `parallel-integrator resume` from
the source worktree. `resume` reacquires the repository lock, verifies the exact
source commit, integration HEAD, merge target, branch, and resolved index, then
validates and commits. This default path makes no nested model request.

Set `conflictResolutionMode` to `nested-codex` only to retain the previous
`codex exec` resolver. That opt-in mode uses the isolated writable `CODEX_HOME`
at `~/.parallel-integrator/codex-home/` and therefore requires network access.

### `resume`

After the workflow has resolved and staged a preserved merge, it runs this from
the original source worktree:

```bash
parallel-integrator resume
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
parallel-integrator status
```

Shows every session, active/ready/waiting/succeeded/`needs_review`/`promotion_pending` state, staging and promoted commits, target branch, recovery phase, worktree paths, latest error, and current lock owners.

### Failure incidents

Failed validation, integration, and resume attempts create immutable incident
tickets under `~/.parallel-integrator/incidents/`. The failure summary prints the
ticket, concise diagnosis, and proposed fix. Inspect its complete stored record
without mutation with:

```bash
parallel-integrator incident CH-YYYYMMDD-XXXXXX
```

Instruction or code fixes proposed by an incident are implemented only in a
new, user-approved session. Repeated failure fingerprints provide evidence for
future workflow improvements. Diagnosis is produced by an ephemeral, read-only,
schema-constrained Codex investigation after releasing the repository lock;
code owns evidence and safety rather than an expanding failure-rule chain. If
that investigation is unavailable or invalid, the ticket records a neutral
fallback instead of guessing. The failed session never edits its own policy.

### `reconcile`

`parallel-integrator reconcile` audits registered repositories for historical session
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
parallel-integrator doctor
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
aggregate JSON record per session under `~/.parallel-integrator/performance/`.
Records separate setup, source validation, lock wait, worktree preparation,
merge, integration validation, commit, promotion, and post-integration timing;
they also include subprocess counts, validation tier, changed-path count, and
cache hits.

`parallel-integrator benchmark` creates disposable small, large, dirty, conflicting,
and concurrent repositories and reports median, p95, and maximum tool/Git
overhead separately from user-configured commands. `--check` enforces CI
regression budgets. `PARALLEL_INTEGRATOR_BENCHMARK_BUDGET_SCALE` scales them for a
consistently slower runner.

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
integration commits through `parallel-integrator`, verifies both with Git, checks the
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
parallel-integrator register "$trial_dir/repo"
git -C "$trial_dir/repo" worktree add -b codex/demo "$trial_dir/demo" main
cd "$trial_dir/demo"
parallel-integrator begin --summary "Disposable demo"
echo demo > demo.txt
git add demo.txt
parallel-integrator commit --message "Add demo"
parallel-integrator validate
parallel-integrator integrate --summary "Added disposable demo" --rollout none
git -C "$trial_dir/repo" log --oneline --graph parallel-integrator/integration
git -C "$trial_dir/repo" log --oneline --graph main
```

## Auditing and disabling the old daemon

First run the read-only audit:

```bash
parallel-integrator audit-legacy
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
  controlled by `parallel-integrator commit`; a crashed Codex session must still be
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
- Optional nested conflict resolution requires a compatible networked `codex exec`; `codexCommand` is a single executable path, not a shell command.
- Stale-lock recovery is intentionally narrow. Ambiguous, dirty, unfinished, missing-metadata, or other-host cases require manual inspection.
- JSON state is designed for a personal local tool, not distributed or multi-host coordination.
