# codex-handoff

`codex-handoff` is a personal, one-shot Git integration CLI for Codex sessions working in parallel worktrees. It has no daemon, watcher, polling service, LaunchAgent, or background queue.

```text
codex-handoff begin
→ Codex changes, validates, and commits its source branch
→ codex-handoff integrate
→ acquire the repository lock
→ merge the exact ready commit in a dedicated integration worktree
→ resolve conflicts with Codex if needed
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
- the `codex` executable when automatic conflict resolution is needed

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
codex-handoff integrate --summary "Implemented feature and tests"
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
  "repositories": [
    {
      "path": "/Users/you/Developer/my-project",
      "gitCommonDir": "/Users/you/Developer/my-project/.git",
      "defaultBranch": "main",
      "integrationBranch": "codex-handoff/integration",
      "setupCommands": [["corepack", "pnpm", "install", "--frozen-lockfile"]],
      "sourceValidationCommands": [
        ["pnpm", "typecheck"],
        ["pnpm", "test"]
      ],
      "integrationValidationCommands": [
        ["pnpm", "typecheck"],
        ["pnpm", "test"]
      ],
      "postIntegrationCommands": [["pnpm", "build"]],
      "conflictInstructions": "Preserve compatible intent and follow repository AGENTS.md."
    }
  ]
}
```

`begin` runs `setupCommands` before creating a branch or session. Integration
runs them after merging and before `integrationValidationCommands`. The workflow
skill runs `sourceValidationCommands` before creating the focused source commit.
After the integration branch advances, the CLI runs `postIntegrationCommands`.
All commands are argument arrays executed directly without a shell.

### `begin`

The workflow skill starts from any clean source worktree:

```bash
codex-handoff begin --summary "Implement comment editing"
```

`begin` first runs centrally configured setup commands, then creates a unique
`codex/session-...` branch when the worktree is detached or on the registered
default branch. A failed setup creates neither a branch nor a session. Existing
non-default branches are unchanged.

Repeat `--depends-on` for explicit dependencies. Pass `--no-auto-branch` only when strict detached/default-branch rejection is desired. `begin` always rejects unregistered or dirty worktrees, the integration branch, unknown dependencies, and duplicate active sessions.

### `integrate`

After source validation and a focused source commit:

```bash
codex-handoff integrate --summary "Implemented comment editing and tests"
```

The ready SHA and timestamp are persisted before dependency or lock checks. Dependencies must already have succeeded. Simultaneous processes wait on an atomic per-repository directory lock, then merge against the current integration branch. The mutable source branch name is never merged.

Conflicts invoke `codex exec --full-auto -` from the integration worktree, with the contextual prompt on stdin. The prompt is also saved under `~/.codex-handoff/logs/`. It includes session timing, summaries, explicit dependencies, later successful integrations, conflicted files, repository instructions, and an explicit rule that start time does not determine precedence.

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
- One preserved `needs_review` merge blocks further integrations for that repository until a human safely resolves or cleans the dedicated integration worktree and lock state.
- Dependency checks fail clearly rather than running a background waiter; retry after dependencies succeed.
- Automatic conflict resolution requires a compatible local `codex exec` command. `codexCommand` is a single executable path, not a shell command.
- Stale-lock recovery is intentionally narrow. Ambiguous, dirty, unfinished, missing-metadata, or other-host cases require manual inspection.
- JSON state is designed for a personal local tool, not distributed or multi-host coordination.
