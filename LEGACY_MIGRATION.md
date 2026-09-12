# Legacy codex-integrator Migration / Coexistence Guide

## Goal

Keep the existing daemon/watcher project intact while introducing `parallel-integrator`.

Old:

```text
~/Developer/tools/codex-integrator
~/.codex-integrator
```

New:

```text
~/Developer/tools/parallel-integrator
~/.parallel-integrator
```

Do not share state directories.

## Why Disable the Old Automation Before Real Use?

Both systems may react to the same Codex work and both may attempt Git integration.

Potential conflicts:

- both changing an integration branch
- old daemon integrating a branch while `parallel-integrator` integrates the same work
- duplicate conflict-resolution calls
- old global instructions marking work ready
- old Git hooks firing
- old skill invoking daemon commands
- multiple integration worktrees fighting over branch checkout

The source code of the old tool does not need to be deleted.

## Phase 1 — Audit Only

Run:

```bash
pintx audit-legacy
```

It should report, without changing anything:

- old project directory
- old state/config directory
- old global skill
- old global Codex instructions
- LaunchAgent plist
- loaded/running launchctl job
- relevant Git hooks
- old integration branch
- old integration worktree

## Phase 2 — Test New Tool in Isolation

Before disabling anything, use a disposable test repository.

Verify:

```text
begin
→ commit
→ integrate
→ conflict resolution
→ tests
→ staging integration commit
→ target promotion
```

## Phase 3 — Disable Old Runtime Automation

Once the new tool works, disable the old **automation**, not necessarily the old source code.

Likely categories:

### LaunchAgent / daemon

If the old project installed a LaunchAgent, use the old project's documented uninstall/stop command when available.

Prefer that over deleting plist files manually.

If no uninstall command exists, inspect the plist and loaded launchctl job before unloading it.

### Old skill

Likely user skill:

```text
~/.agents/skills/codex-integrator-workflow/
```

Prefer disabling it in Codex configuration or renaming/moving it before deleting it.

Do not keep both old and new skills implicitly triggering the same task lifecycle.

### Global AGENTS instructions

Edit:

```text
~/.codex/AGENTS.md
```

Remove or disable instructions that automatically call:

```text
codex-integrator ...
```

Replace them with the new `parallel-integrator-workflow` snippet.

### Git hooks

For each active project, inspect:

```bash
git config --get core.hooksPath
```

and the relevant `.git/hooks` directory.

Disable hooks that invoke the old `codex-integrator`.

Do not remove unrelated hooks.

### Old integration branch

Do not delete it initially.

New tool defaults to:

```text
parallel-integrator/integration
```

This avoids branch collision while validating the new design.

This branch is internal staging, not the final destination. The effective
target defaults to each registration's `defaultBranch`; set `targetBranch` only
for an intentional per-repository override.

## Phase 4 — Real Project Trial

Use the new system on one real repository.

Keep the old daemon source/config available for rollback, but leave the old runtime automation stopped.

Before a real trial, audit older handoff state:

```bash
pintx reconcile
```

Review every `PENDING` result. Use `reconcile --apply` only when the command
reports a recorded, ancestry-safe fast-forward. Divergent or unrecorded staging
history requires manual Git review; do not reset or merge it blindly.

## Phase 5 — Optional Cleanup

Only after the new system is stable:

- archive old runtime logs/state
- remove old skill
- remove old LaunchAgent
- remove obsolete Git hooks
- optionally archive the old source project

Deleting the old integration branch is optional and should be a separate deliberate Git decision.

## Rollback

If `parallel-integrator` proves worse:

1. stop using the new skill
2. restore previous `~/.codex/AGENTS.md`
3. re-enable the old skill
4. reload/restart old daemon using its own documented commands

Because the two systems use different state directories and integration branches, rollback should remain straightforward.

## Important

`parallel-integrator` implementation must not automatically uninstall the old system.

It may provide exact recommended commands after auditing, but destructive actions require explicit user action.

## Pull-request promotion modes

Existing `promotion.type: "pull-request"` entries require no migration. An
omitted `mode` continues to mean `shared-target`, so the configured target PR is
reused exactly as before.

To adopt independent review per handoff, set `mode` to `session-branch`. New or
resumed sessions then push their own source branch and use a session-marked PR;
existing shared-target PRs are not closed, merged, edited, or deleted. Confirm
the remote base exists and run `pintx doctor` to verify branch syntax,
remote configuration, and GitHub CLI authentication before first use.
