# TASKS.md

Complete personal MVP implementation checklist.

## Foundation

- [x] Initialize pnpm + TypeScript + ESM
- [x] Enable strict TypeScript
- [x] Add build, typecheck, test, and formatting scripts
- [x] Add the CLI command set, including tier selection with `validate`
- [x] Keep the module set small

## Runtime data and registration

- [x] Add an optional global `defaultTargetBranch` with per-repository override precedence
- [x] Apply the global target dynamically to existing registrations that omit `targetBranch`
- [x] Add opt-in, resumable target-to-production pull-request promotion with configured reviewers
- [x] Add global default reviewers and assignees with per-repository pull-request overrides
- [x] Add per-session source-branch PR promotion while preserving shared-target mode
- [x] During registration/readiness, safely track or create the global target without switching or pushing the user checkout
- [x] Cover existing, new, remote-tracking, unborn, and explicitly overridden repository cases

- [x] Create the separate `~/.codex-handoff/` namespace
- [x] Implement idempotent `init`, JSON config/state, and atomic writes
- [x] Implement `register` with real repository/common-dir resolution
- [x] Detect and store the default branch
- [x] Prevent duplicate registrations
- [x] Default to `codex-handoff/integration`
- [x] Keep the staging branch separate from an optional target branch that defaults to `defaultBranch`
- [x] Optionally auto-configure safe package validation scripts without overwriting existing commands
- [x] Detect, store, and run centralized worktree setup commands for registered repositories
- [x] Keep auto-detected setup advisory at begin while requiring explicit and integration setup

## Session start

- [x] Implement `begin`
- [x] Reject staged/indeterminate baseline state, integration worktrees, and duplicate active sessions, with an explicit strict opt-out for detached/default branches
- [x] Let the workflow safely auto-create a unique task branch from baseline-safe detached/default-branch worktrees
- [x] Let Codex CLI create an isolated managed source worktree from an ordinary checkout while preserving launch-checkout state
- [x] Record worktree, branch, start commit, integration HEAD, timestamp, summary, and dependencies
- [x] Record a pre-setup observable Git baseline and distinguish stable inaccessible paths from genuine task/unrelated changes
- [x] Reject unknown explicit dependencies

## One-shot integration

- [x] Find the current worktree session and require a clean unchanged source branch
- [x] Persist the exact ready commit, timestamp, and completion summary before integration
- [x] Enforce explicit dependency results before and after lock acquisition
- [x] Acquire an atomic per-repository lock with bounded waiting and owner metadata
- [x] Refresh integration state after lock acquisition
- [x] Create/reuse a dedicated integration worktree without resetting its branch
- [x] Refuse dirty or unfinished integration worktrees
- [x] Merge the exact ready SHA rather than a mutable branch
- [x] Never modify the source worktree

## Conflict resolution, validation, and result

- [x] Detect unmerged files and invoke Codex non-interactively
- [x] Select source and integration validation tiers from the exact task diff
- [x] Directly integrate explicitly classified trivial changes without a worktree when safe
- [x] Fall back to normal worktree integration on conflicts or unmet bypass guards
- [x] Persist a prompt containing timing, summaries, commits, conflicts, later integrations, dependencies, `AGENTS.md`, and conflict instructions
- [x] State that timestamps are context and do not determine precedence
- [x] Verify all conflicts are resolved and staged
- [x] Run integration validation commands in order and stop on first failure
- [x] Commit only after successful validation
- [x] Promote first, then run post-integration commands from the clean checked-out target worktree
- [x] Preserve post-integration failures and the already-promoted commit for review
- [x] Record the integration commit/result or `needs_review` error
- [x] Promote the exact validated staging commit with expected-old verification
- [x] Synchronize a clean checked-out target and preserve dirty/inaccessible targets as `promotion_pending`
- [x] Resume post-check and promotion failures without rebuilding a moving source tip
- [x] Preserve failed integration state for diagnosis and release the controlled lock
- [x] Run Codex conflict resolution with isolated writable state and workspace sandboxing
- [x] Default to current-session conflict resolution with a verified `resume` command
- [x] Retain nested Codex resolution as an explicit compatibility mode

## Lock reliability and status

- [x] Show lock waiting and owner details
- [x] Detect a same-host dead owner
- [x] Inspect merge/dirty state before limited stale-lock recovery
- [x] Never blindly remove ambiguous or unfinished locks
- [x] Implement status output for sessions, commits, times, paths, locks, and latest errors
- [x] Show staging, target, promotion, and recovery-phase diagnostics

## Legacy audit

- [x] Implement read-only `audit-legacy`
- [x] Detect likely source, runtime, skill, global instruction/config, LaunchAgent, launchctl, hook, branch, and worktree artifacts
- [x] Print `FOUND` / `NOT FOUND` / `UNKNOWN` and safe disable guidance
- [x] Never edit or delete legacy components
- [x] Add explicit read-only historical promotion reconciliation with opt-in safe fast-forward apply

## Readiness doctor

- [x] Implement one read-only `doctor` command
- [x] Check installation, runtime, configuration, repository validation, locks, and legacy automation
- [x] Print `READY` or actionable `NOT READY` output with meaningful exit status

## Skill and global guidance

- [x] Preserve and clarify `codex-handoff-workflow`
- [x] Add an idempotent user-skill installation script
- [x] Require begin before edits and configured source validation before completion
- [x] Require a focused source commit and one-shot integrate
- [x] Never invoke `codex-integrator`
- [x] Supply global guidance with registration, read-only, branch, and self-repository guards
- [x] Make CLI-first invocation create/reuse a source worktree without relying on application mode labels

## Disposable verification

- [x] Begin metadata and exact clean merge
- [x] Concurrent finish serialization and refreshed integration state
- [x] Fake-Codex conflict resolution with timing/later-integration context
- [x] Earlier start time does not automatically win
- [x] Explicit dependency blocking and retry
- [x] Failed validation prevents a commit
- [x] Post-integration ordering and failure preservation
- [x] Unresolved conflict becomes `needs_review`
- [x] Source worktrees remain untouched
- [x] Default and overridden target promotion
- [x] Checked-out clean, dirty, inaccessible, and concurrently moved target handling
- [x] Historical missing-promotion fast-forward and divergent-history refusal
- [x] Dirty interrupted integration makes stale-lock recovery conservative
- [x] Legacy audit does not mutate legacy fixtures
- [x] Doctor ready/failure paths do not mutate runtime or home fixtures

## Performance

- [x] Reuse exact-tree source validation during integration when fingerprints match
- [x] Cache advisory setup and validation conservatively by content fingerprints
- [x] Auto-configure documentation and test validation tiers
- [x] Support explicit parallel validation command groups
- [x] Batch Git content hashing and parallelize independent Git metadata probes
- [x] Index the latest worktree session while retaining JSON session history
- [x] Persist phased per-session timing, subprocess, tier, path, and cache metrics
- [x] Benchmark disposable small, large, dirty, conflict, and concurrent scenarios
- [x] Provide median, p95, maximum, and CI regression-budget reporting

## Documentation

- [x] Exact install, CLI, configuration, and test commands
- [x] Disposable manual trial
- [x] Old daemon audit/disable and rollback guidance
- [x] Known limitations

## GPG reliability

- [x] Add a controlled signed source-commit command
- [x] Run real signing preflights immediately before source and integration commits
- [x] Provide a no-autostart health-checking wrapper with launchd recovery
- [x] Provide a keepalive canonical-agent LaunchAgent installer with config backups
- [x] Retain fake-GPG coverage and add an opt-in real sandboxed end-to-end test
