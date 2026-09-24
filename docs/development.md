# Development and verification

[Back to the README](../README.md)

Commands below run from the repository root unless stated otherwise.

- [Developing sesh-integrator concurrently](#developing-sesh-integrator-concurrently)
- [Optional maintainer safeguards](#optional-maintainer-safeguards)
- [Disposable-repository verification](#disposable-repository-verification)
- [Release smoke tests](#release-smoke-tests)
- [Performance reporting and benchmarks](#performance-reporting-and-benchmarks)
- [Real macOS signing reliability](#real-macos-signing-reliability)

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
The installer checks existing runtime compatibility before atomically publishing each alias. It does not validate the build or refresh skills/hooks automatically. Interrupted alias publication can be retried; complete older releases remain available.

Pin the real path once per session (record it with your task notes for recovery):

```bash
export SESH_COORDINATOR="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v seshx)")"
node "$SESH_COORDINATOR" status
node "$SESH_COORDINATOR" register --auto-config
```

In the runtime's `config.json` (use the `Runtime:` path from status), set this
repository's `targetBranch` to `dev`. Leave `promotion` unset for local-only
integration. Explicitly configured PR promotion authorizes the integrator to
push the target without force and create/update its PR. Direct agent-issued
pushes, force-pushes, and PR merges require an explicit user request. Auto-configuration
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

#### Focused dashboard validation

For this repository, add a `dashboard` entry to `validationTiers` in the
effective runtime's `config.json`, after the docs tier and before broad test
tiers. Limit its `paths` to `src/dashboard.ts`, `test/dashboard*.test.ts`, and
`docs/development.md`. In both `sourceValidationCommands` and
`integrationValidationCommands`, use these argument arrays in order:

```json
[
  ["corepack", "pnpm", "run", "format:check"],
  ["corepack", "pnpm", "run", "typecheck"],
  ["corepack", "pnpm", "run", "build"],
  [
    "corepack",
    "pnpm",
    "exec",
    "vitest",
    "run",
    "test/dashboard.test.ts",
    "test/dashboard-clock.test.ts",
    "test/dashboard-watch.test.ts"
  ]
]
```

Build before the dashboard tests because they invoke `dist/cli.js`. Keep
`validationCache: "session"` so integration can reuse checks for the exact same
tree. Changes outside those paths fall back to the other tiers or full checks;
do not extend the dashboard tier to shared lifecycle code or package files.
Finish an existing validation process before starting another full suite,
including after a parallel validation command reports a failure. This avoids
overlapping leftover tests and resource-related timeouts.

#### Updating the installed dashboard

Source promotion and executable installation are separate completion steps.
`seshx` points to a stable release copy, so rebuilding the checkout does not
update the installed dashboard. After successful integration, use the clean
validated source worktree whose tree matches the promoted `dev` tree:

```bash
pnpm build
./scripts/install-cli.sh --stable
```

Keep existing sessions on their pinned coordinator and retain its release;
never overwrite that snapshot. The installer checks compatibility and publishes
a new snapshot for future invocations. Do not install from merge or validation
hooks. Quit and reopen `seshx dashboard` to load the new executable. On a host
without the POSIX installer, perform the equivalent validated snapshot install
using that host's installation procedure.

When a task requests a visible local dashboard change, include installation and
a check of the installed renderer in its completion checklist. Report whether
the executable was updated, and record any deferred installation as an explicit
follow-up. Do not describe source promotion alone as an installed UI update.

Before PR promotion, fetch `origin/main` and verify it is an ancestor of `dev`.
After a shared PR is merged, synchronize the exact fetched merge commit in a
separate managed source session, validate and integrate that session, then
continue the original task. Preserve pending sessions and dirty launch files;
never bypass the pre-push ancestry guard.

Keep the pinned coordinator for unfinished self-development sessions. Compatible upgrades may be installed for new sessions; incompatible contracts are rejected before lifecycle mutation. Finish sessions with their retained coordinator before adopting incompatible runtime schemas. Install a new validated snapshot, explicitly refresh installed
workflows with its `scripts/install-skill.sh --installed`, and use its path for
new sessions. Retain old snapshots for recovery. Neither merge hooks nor health
checks synchronize `dev` or install candidate builds automatically. The optional
`self-hosting-sync-dev` script is a manual maintenance operation only; do not run
it during active sessions. Existing hook/timer installations should point at the
stable snapshot's scripts; run its
`scripts/install-machine-safeguards.sh --repo /path/to/sesh-integrator` to refresh them.

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
[GLOBAL_AGENTS_SNIPPET.md](../GLOBAL_AGENTS_SNIPPET.md). Surrounding global
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

### Release smoke tests

`pnpm test:smoke` checks installation from the npm tarball, the full CLI lifecycle,
and failure/timeout recovery for every harness adapter. These credential-free
tests also run in normal CI. `pnpm test:smoke:live --harness codex` (or `--all`) separately checks real edits
and conflict resolution using explicitly selected harnesses. Codex reuses your
existing login with no separate sandbox-home setup; other harnesses retain their
sandbox authentication requirements.
See [smoke test setup and budget requirements](../smoke/README.md).

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
