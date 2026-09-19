# Installation and upgrades

[Back to the README](../README.md)

Commands below run from the repository root unless stated otherwise.

- [Install](#install)
- [Adopting existing work and changing installations](#adopting-existing-work-and-changing-installations)
- [Install from source](#install-from-source)
- [Renaming an existing installation](#renaming-an-existing-installation)
- [macOS upgrade export](#macos-upgrade-export)
- [Auditing and disabling the old daemon](#auditing-and-disabling-the-old-daemon)

### Install

Requires Node.js 20+ and Git. The npm package includes the built CLI; users do
not need pnpm or a source checkout. Once the package is published to npm:

```bash
npm install -g --foreground-scripts sesh-integrator
seshx setup
```

The install script prints a reminder to run `seshx setup`; `--foreground-scripts`
makes it visible because npm otherwise hides lifecycle output. Setup remains a
separate, interactive step. Disabling lifecycle scripts skips the reminder.

`setup` detects `codex`, `claude`, `agy`, and `grok` executables on `PATH`,
preselects detected harnesses, and lets you choose integrations. It previews the
skill and global instruction paths before confirmation, initializes configuration,
and verifies Git and installed files. Detection does not execute harnesses or
check authentication. Personal instructions outside the managed block are preserved.
Customized skill files are preserved; back them up and move them before reinstalling.
Standard home directories are supported; custom harness homes require manual setup.

For unattended installation, explicitly choose integrations:

```bash
seshx setup --detected --yes
seshx setup --harness claude --harness antigravity --yes
```

Then, in your project:

```bash
seshx register --auto-config
seshx doctor --installed
```

To remove installed integrations, run `seshx uninstall` (or `--yes` unattended).
Use `--harness <name>` to remove one integration. Only unchanged managed files and
managed guidance are removed; customized content, configuration, sessions, and
worktrees remain. Uninstall stops new enrollment for selected harnesses. If any of their sessions are unfinished (including waiting, conflicted, validation-pending, or promotion-pending), removal is deferred and their guidance and recovery assets stay installed. Finish those sessions and rerun uninstall. Empty skill directories may remain. Remove the npm CLI separately:

```bash
npm uninstall -g sesh-integrator
```

### Adopting existing work and changing installations

Repository-scoped `register` and `begin` report observable dirty checkout state
and unfinished managed sessions. `begin --create-worktree` continues to preserve
and exclude dirty launch-checkout work. Its owner decides how to settle those
edits; the tool never commits, stashes, imports, or discards them. Dirty target
files may block eventual promotion. After their owner commits them, `resume`
reconciles that target with the preserved integration and validates both.

Global setup cannot know which repositories you intend to adopt. Neither setup
nor Git inspection discovers or enrolls already-open agent conversations. Tell
those conversations to inspect status and continue an appropriate session or
start an isolated task; do not copy old edits into it automatically.

New sessions record a SHA-256 identity of the executable and bundled resources,
package version, state contract, recovery contract, and an independent CLI path
under `<runtime>/coordinators/<build-id>/dist/cli.js`. Setup and begin retain these
assets before enrollment; no automatic pruning removes them. Local builds with
the same version can have different identities. `status --session <id>` reports
the original coordinator, missing/modified assets, and the coordinator used for
recovery. Use `node <recorded-cli-path> resume --session <id>` from the source
worktree. Node.js 20+, Git, project dependencies and any configured external
commands must still be available; they are not bundled.

`seshx installation-check` performs a read-only compatibility check. Source
installation runs it before changing aliases, and mutation commands check
unfinished session and recovery contracts. Contract 1 readers accept legacy
records without a contract and compatible contract 1 builds; unknown contracts
are refused with the original executable path and required contract numbers.
Legacy build identity cannot be reconstructed; first recovery retains the
current compatible build. Pre-contract older CLIs cannot enforce new contracts:
keep their pinned executables and do not use them on newer recovery records.

Reinstall reuses the existing runtime home (including legacy home precedence),
configuration, sessions, locks and recovery bundles. Keep the same home/env
settings. Setup displays unfinished sessions and re-enables enrollment only for
the selected, successfully installed harnesses. Customized skills and guidance
are preserved, as are other harness integrations. Per-file installation receipts
retain the previous digest across interrupted upgrades. A leftover configuration
lock requires inspecting the owning operation before retrying; it is never
blindly removed. Installation does not resume integrations or clear repository
locks on your behalf.

Direct `npm uninstall -g sesh-integrator` cannot be prevented. Independent runtime
coordinator copies survive package removal; reinstall a compatible build if the
original copy is also missing. A same-build reinstall can retain an independent
replacement for damaged assets without overwriting them. If runtime data or Git
objects were separately deleted, reinstall cannot recreate lost work. Back up
runtime data and repositories together. Do not delete recovery refs or bundles.

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
