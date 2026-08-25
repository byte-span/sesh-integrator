# codex-handoff

`codex-handoff` is a personal, one-shot Git integration CLI for Codex sessions working in parallel worktrees. It has no daemon, watcher, polling service, LaunchAgent, or background queue.

```text
codex-handoff begin
→ create/reuse an isolated source worktree for Codex CLI
→ Codex changes and commits its source branch
→ codex-handoff validate
→ codex-handoff integrate
→ acquire the repository lock
→ merge the exact ready commit in a dedicated integration worktree
→ let the current Codex session resolve conflicts if needed
→ codex-handoff resume
→ validate and commit on the internal staging branch
→ safely promote the exact validated commit to the configured target branch
→ run post-integration checks from that target branch's clean worktree
→ record success, release the lock, and exit
```

The new runtime and internal staging branch are deliberately separate from the legacy daemon:

```text
new: ~/.codex-handoff/       codex-handoff/integration
old: ~/.codex-integrator/    codex/integration
```

## Requirements and installation

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
codex-handoff init
```

The CLI installer creates an idempotent symlink in `~/.local/bin`, which must be on `PATH`. Set `CODEX_HANDOFF_BIN_DIR` to choose another user-writable bin directory. It also installs the machine safeguards: the bundled skill, managed guidance blocks, conservative self-hosting Git hooks, and a bounded six-hourly user systemd health check.

`scripts/install-skill.sh` idempotently installs the supplied skill at `~/.agents/skills/codex-handoff-workflow/`. It accepts an alternate destination for testing:

```bash
./scripts/install-skill.sh /tmp/codex-handoff-skill
```

Only delimited managed sections are synchronized. Global guidance comes from
[GLOBAL_AGENTS_SNIPPET.md](./GLOBAL_AGENTS_SNIPPET.md), and every registered
repository receives [REPOSITORY_AGENTS_SNIPPET.md](./REPOSITORY_AGENTS_SNIPPET.md).
All surrounding user and project-specific instructions are preserved.

## Commands

These are the complete commands implemented by the MVP:

```bash
codex-handoff init
codex-handoff register [repo-path] [--auto-config] [--setup-command '<json-array>']...
codex-handoff begin --summary "Implement feature" [--create-worktree] [--no-auto-branch] [--depends-on <session-id>]...
codex-handoff commit --message "Implement feature" [--session <session-id>]
codex-handoff validate [--session <session-id>]
codex-handoff integrate --summary "Implemented feature and tests" [--session <session-id>]
codex-handoff resume [--session <session-id>]
codex-handoff status [--session <session-id>]
codex-handoff reconcile [repo-path] [--apply]
codex-handoff audit-legacy
codex-handoff doctor
codex-handoff benchmark [--runs <n>] [--json] [--check]
```

There are no `run`, `daemon`, `watch`, or service-management commands.

### `init`

Creates, without overwriting an existing configuration:

```text
~/.codex-handoff/
├── config.json
├── state.json
├── codex-home/
├── sessions/
├── indexes/
├── performance/
├── cache/
├── locks/
├── logs/
├── source-worktrees/
└── worktrees/
```

Set `CODEX_HANDOFF_HOME` to use a different runtime root, including in tests.

### `register`

Run once for each repository:

```bash
cd ~/Developer/my-project
codex-handoff register
```

Registration records the real Git common directory, branches, and central
setup/validation commands. Re-registering updates requested empty command lists
rather than adding a duplicate.

Pass `--auto-config` to detect setup commands plus safe root `package.json`
validation scripts. It works during initial registration and for an existing
registration:

```bash
codex-handoff register --auto-config
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
argument arrays to `~/.codex-handoff/config.json`. If no supported scripts are
found, registration still succeeds and reports that the command lists remain
unconfigured.

For an unknown ecosystem, provide one or more argument arrays once during
registration:

```bash
codex-handoff register --setup-command '["make","bootstrap"]'
```

Edit `~/.codex-handoff/config.json` to add validation and conflict settings. Commands are argument arrays and are never passed through a shell:

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
      "integrationBranch": "codex-handoff/integration",
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

After local promotion and post-integration checks pass, `codex-handoff` performs
a normal non-force push, reuses an existing open PR for the same branch pair or
creates a ready-for-review PR, requests configured reviewers, and adds configured
assignees. Omit
`productionBranch` to use `defaultBranch`, omit `remote` to use `origin`, and
omit `reviewers` when CODEOWNERS or another GitHub policy assigns reviewers.
The remote step requires authenticated `git` and `gh` access. Failures remain
resumable with `codex-handoff resume`.

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
and set an explicit target in `~/.codex-handoff/config.json`:

```json
{
  "defaultBranch": "main",
  "integrationBranch": "codex-handoff/integration",
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

`gpgProgram` is optional. When set, `codex-handoff` applies it only to its
controlled source and integration commit commands. When signing is enabled,
the CLI performs a real in-memory OpenPGP signing preflight immediately before
each commit and refuses to invoke Git if the agent, key, pinentry, or program is
unavailable. Direct-integration merge commits are signed when the effective
`commit.gpgSign` setting is enabled.

Auto-configured setup is `advisory` during `begin`: failure prints a warning but
does not block branch or session creation. Explicit `--setup-command` setup is
`required` and still blocks `begin` on failure. Integration normally requires
successful setup before its selected validation commands. The workflow skill
commits the focused change, then runs `codex-handoff validate` against that exact
commit. After the staging branch advances, the CLI promotes the validated
commit and runs `postIntegrationCommands` from the clean worktree checking out
the target branch. Configuring these commands therefore requires exactly one
accessible, clean target checkout. All commands are argument arrays executed
directly without a shell.

Validation tiers are evaluated in configuration order. A tier matches only when
every changed path matches at least one of its glob patterns; otherwise the
legacy source/integration lists form the `full` tier. `--auto-config` adds a
documentation-only tier. Re-run registration with `--auto-config` to add it to
an existing repository with no tiers configured.

An explicitly configured tier may set `bypassIntegrationWorktree` to `true`.
The bypass is used only for the exact commit previously checked by
`codex-handoff validate`, and only when the tier has no integration commands and
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
codex-handoff begin --create-worktree --summary "Implement comment editing"
```

The command creates a unique branch and linked worktree below
`~/.codex-handoff/source-worktrees/`, records the original launch checkout, and
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
codex-handoff commit --message "Implement comment editing"
codex-handoff validate
codex-handoff integrate --summary "Implemented comment editing and tests"
```

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
`~/.codex-handoff/logs/`. The workflow skill directs the current Codex session to
resolve and stage the preserved worktree, then runs `codex-handoff resume` from
the source worktree. `resume` reacquires the repository lock, verifies the exact
source commit, integration HEAD, merge target, branch, and resolved index, then
validates and commits. This default path makes no nested model request.

Set `conflictResolutionMode` to `nested-codex` only to retain the previous
`codex exec` resolver. That opt-in mode uses the isolated writable `CODEX_HOME`
at `~/.codex-handoff/codex-home/` and therefore requires network access.

### `resume`

After the workflow has resolved and staged a preserved merge, it runs this from
the original source worktree:

```bash
codex-handoff resume
```

Do not run it from the integration worktree. It resumes only the matching
`needs_review` or `promotion_pending` session and refuses changed source snapshots, mismatched merge
commits, unresolved files, or a moved integration branch. It also retries an
unchanged clean merge after validation or commit creation failed, but only when
the staged tree exactly matches Git's reconstructed merge tree.

For `promotion_pending`, `resume` retries only the recorded validated staging
commit against the recorded expected target SHA. It does not rebuild from a
source branch that may have advanced. Post-integration failures are likewise
resumable and rerun their configured checks from the promoted target worktree.

Validation failure or unresolved conflict leaves the integration worktree intact, records `needs_review`, releases the one-shot lock, and exits nonzero. A failed post-integration command also records `needs_review`, but preserves the already-promoted target commit; its command, exit code, stdout, and stderr remain in the session record for diagnosis. If post-integration commands are configured and the target is not checked out in exactly one clean accessible worktree, promotion remains pending. Post-integration commands are skipped when the ready commit was already present and the staging branch did not advance. The source worktree is never modified.

### `status`

```bash
codex-handoff status
```

Shows every session, active/ready/waiting/succeeded/`needs_review`/`promotion_pending` state, staging and promoted commits, target branch, recovery phase, worktree paths, latest error, and current lock owners.

### `reconcile`

`codex-handoff reconcile` audits registered repositories for historical session
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
codex-handoff doctor
```

It checks Node.js, Git, the configured Codex executable, runtime/config files, the installed workflow skill, synchronized managed global and registered-repository guidance without stale concurrency prohibitions, current-project registration, separate staging/target branch ancestry, source and integration validation commands, active locks, and conflicting legacy automation. It prints `READY`, `READY WITH ... WARNINGS`, or `NOT READY` with actionable details. A `NOT READY` result exits nonzero. Warnings cover checks that could not be confirmed safely, such as an unavailable `launchctl` query.

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
aggregate JSON record per session under `~/.codex-handoff/performance/`.
Records separate setup, source validation, lock wait, worktree preparation,
merge, integration validation, commit, promotion, and post-integration timing;
they also include subprocess counts, validation tier, changed-path count, and
cache hits.

`codex-handoff benchmark` creates disposable small, large, dirty, conflicting,
and concurrent repositories and reports median, p95, and maximum tool/Git
overhead separately from user-configured commands. `--check` enforces CI
regression budgets. `CODEX_HANDOFF_BENCHMARK_BUDGET_SCALE` scales them for a
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
CODEX_HANDOFF_REAL_GPG_E2E=1 ./scripts/test-real-gpg-e2e.sh initial
CODEX_HANDOFF_REAL_GPG_E2E=1 ./scripts/test-real-gpg-e2e.sh after-wake
CODEX_HANDOFF_REAL_GPG_E2E=1 ./scripts/test-real-gpg-e2e.sh after-fresh-login
```

It uses `sandbox-exec` to deny writes to `~/.gnupg`, creates signed source and
integration commits through `codex-handoff`, verifies both with Git, checks the
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
codex-handoff register "$trial_dir/repo"
git -C "$trial_dir/repo" worktree add -b codex/demo "$trial_dir/demo" main
cd "$trial_dir/demo"
codex-handoff begin --summary "Disposable demo"
echo demo > demo.txt
git add demo.txt
codex-handoff commit --message "Add demo"
codex-handoff validate
codex-handoff integrate --summary "Added disposable demo"
git -C "$trial_dir/repo" log --oneline --graph codex-handoff/integration
git -C "$trial_dir/repo" log --oneline --graph main
```

## Auditing and disabling the old daemon

First run the read-only audit:

```bash
codex-handoff audit-legacy
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
  controlled by `codex-handoff commit`; a crashed Codex session must still be
  resumed manually.
- A running Codex CLI process cannot change its parent shell directory. The
  agent must honor the `Continue task in:` path for all subsequent tool calls.
- Managed source worktrees are retained after completion; cleanup is currently
  manual and must not remove a worktree containing uncommitted state.
- The tool does not fetch, force-push, delete branches, or merge/reset user worktrees. It pushes only when a repository explicitly enables pull-request promotion.
- One preserved `needs_review` merge blocks further integrations because the dedicated integration worktree contains its recovery state; unrelated source sessions may continue working and can integrate after it is resumed.
- Dependency checks fail clearly rather than running a background waiter; retry after dependencies succeed.
- The current-session resolution path is instruction-driven; genuinely ambiguous conflicts or failed validation still require user review.
- Optional nested conflict resolution requires a compatible networked `codex exec`; `codexCommand` is a single executable path, not a shell command.
- Stale-lock recovery is intentionally narrow. Ambiguous, dirty, unfinished, missing-metadata, or other-host cases require manual inspection.
- JSON state is designed for a personal local tool, not distributed or multi-host coordination.
