# codex-handoff

`codex-handoff` is a personal, one-shot Git integration CLI for Codex sessions working in parallel worktrees. It has no daemon, watcher, polling service, LaunchAgent, or background queue.

```text
codex-handoff begin
→ Codex changes and commits its source branch
→ codex-handoff validate
→ codex-handoff integrate
→ acquire the repository lock
→ merge the exact ready commit in a dedicated integration worktree
→ let the current Codex session resolve conflicts if needed
→ codex-handoff resume
→ validate, commit, record the result, release the lock, and exit
```

The new runtime and branch are deliberately separate from the legacy daemon:

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
./scripts/install-skill.sh
```

The CLI installer creates an idempotent symlink in `~/.local/bin`, which must be on `PATH`. Set `CODEX_HANDOFF_BIN_DIR` to choose another user-writable bin directory.

`scripts/install-skill.sh` idempotently installs the supplied skill at `~/.agents/skills/codex-handoff-workflow/`. It accepts an alternate destination for testing:

```bash
./scripts/install-skill.sh /tmp/codex-handoff-skill
```

Finally, copy [GLOBAL_AGENTS_SNIPPET.md](./GLOBAL_AGENTS_SNIPPET.md) into `~/.codex/AGENTS.md`. It excludes this tool's own repository, read-only tasks, and the integration branch while allowing the skill to leave detached/default-branch worktrees safely.

## Commands

These are the complete commands implemented by the MVP:

```bash
codex-handoff init
codex-handoff register [repo-path] [--auto-config] [--setup-command '<json-array>']...
codex-handoff begin --summary "Implement feature" [--no-auto-branch] [--depends-on <session-id>]...
codex-handoff validate
codex-handoff integrate --summary "Implemented feature and tests"
codex-handoff resume
codex-handoff status
codex-handoff audit-legacy
codex-handoff doctor
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
├── locks/
├── logs/
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
  "repositories": [
    {
      "path": "/Users/you/Developer/my-project",
      "gitCommonDir": "/Users/you/Developer/my-project/.git",
      "defaultBranch": "main",
      "integrationBranch": "codex-handoff/integration",
      "setupCommands": [["corepack", "pnpm", "install", "--frozen-lockfile"]],
      "setupCommandPolicy": "advisory",
      "sourceValidationCommands": [
        ["pnpm", "typecheck"],
        ["pnpm", "test"]
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

Auto-configured setup is `advisory` during `begin`: failure prints a warning but
does not block branch or session creation. Explicit `--setup-command` setup is
`required` and still blocks `begin` on failure. Integration normally requires
successful setup before its selected validation commands. The workflow skill
commits the focused change, then runs `codex-handoff validate` against that exact
commit. After the integration branch advances, the CLI runs
`postIntegrationCommands`. All
commands are argument arrays executed directly without a shell.

Validation tiers are evaluated in configuration order. A tier matches only when
every changed path matches at least one of its glob patterns; otherwise the
legacy source/integration lists form the `full` tier. `--auto-config` adds a
documentation-only tier. Re-run registration with `--auto-config` to add it to
an existing repository with no tiers configured.

An explicitly configured tier may set `bypassIntegrationWorktree` to `true`.
The bypass is used only for the exact commit previously checked by
`codex-handoff validate`, and only when the tier has no integration commands and
the repository has no post-integration commands. Under the repository lock, the
CLI uses Git plumbing and atomically advances the integration ref. Conflicts or
unsupported Git fall back to the normal integration worktree. A clean,
tool-owned integration worktree may be removed before this update; user
worktrees are never removed.

### `begin`

The workflow skill starts from a source worktree whose observable state can be
safely baselined:

```bash
codex-handoff begin --summary "Implement comment editing"
```

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

Repeat `--depends-on` for explicit dependencies. Pass `--no-auto-branch` only when strict detached/default-branch rejection is desired. `begin` always rejects unregistered worktrees, staged baseline changes, indeterminate new errors, the integration branch, unknown dependencies, and duplicate active sessions.

Sessions created by versions that did not record an observable Git baseline
fail validation/integration with a migration message asking you to begin a new
session; they are never silently interpreted using weaker cleanliness rules.

### `integrate`

After a focused source commit and tiered source validation:

```bash
codex-handoff validate
codex-handoff integrate --summary "Implemented comment editing and tests"
```

The ready SHA and timestamp are persisted before dependency or lock checks. Dependencies must already have succeeded. Simultaneous processes wait on an atomic per-repository directory lock, then merge against the current integration branch. The mutable source branch name is never merged.

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
`needs_review` session and refuses changed source snapshots, mismatched merge
commits, unresolved files, or a moved integration branch.

Validation failure or unresolved conflict leaves the integration worktree intact, records `needs_review`, releases the one-shot lock, and exits nonzero. A failed post-integration command also records `needs_review`, but preserves the integration commit because the branch has already advanced; its command, exit code, stdout, and stderr remain in the session record for diagnosis. Post-integration commands are skipped when the ready commit was already present and the branch did not advance. The source worktree is never modified.

### `status`

```bash
codex-handoff status
```

Shows every session, active/ready/waiting/succeeded/`needs_review` state, timestamps, commits, worktree paths, latest error, and current lock owners.

If a process dies, a same-host dead-PID lock is removed automatically only when the integration worktree is verifiably clean and has no merge in progress. Otherwise the lock and worktree are preserved with manual recovery guidance. A missing owner record or remote-host owner is treated conservatively.

### `doctor`

Run one read-only readiness check from the project you intend to use:

```bash
codex-handoff doctor
```

It checks Node.js, Git, the configured Codex executable, runtime/config files, the installed workflow skill, synchronized global guidance without stale branch prohibitions, current-project registration, source and integration validation commands, active locks, and conflicting legacy automation. It prints `READY`, `READY WITH ... WARNINGS`, or `NOT READY` with actionable details. A `NOT READY` result exits nonzero. Warnings cover checks that could not be confirmed safely, such as an unavailable `launchctl` query.

## Disposable-repository verification

The Vitest suite creates only disposable temporary Git repositories and uses fake Codex executables for deterministic conflicts:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

It proves begin metadata, exact clean merges, simultaneous serialization, refreshed integration state, contextual conflict resolution, non-precedence of start time, dependencies, validation failure, unresolved conflicts, untouched source worktrees, conservative stale-lock behavior, read-only legacy audit, and both successful and failing read-only doctor checks.

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
git commit -m "Add demo"
codex-handoff integrate --summary "Added disposable demo"
git -C "$trial_dir/repo" log --oneline --graph codex-handoff/integration
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

- Skill invocation and source commit creation are instruction-driven. A crashed Codex session must be resumed manually.
- The tool does not fetch, push, force-push, delete branches, or update the default branch.
- One preserved `needs_review` merge blocks further integrations until the workflow resolves it and runs `resume`.
- Dependency checks fail clearly rather than running a background waiter; retry after dependencies succeed.
- The current-session resolution path is instruction-driven; genuinely ambiguous conflicts or failed validation still require user review.
- Optional nested conflict resolution requires a compatible networked `codex exec`; `codexCommand` is a single executable path, not a shell command.
- Stale-lock recovery is intentionally narrow. Ambiguous, dirty, unfinished, missing-metadata, or other-host cases require manual inspection.
- JSON state is designed for a personal local tool, not distributed or multi-host coordination.
