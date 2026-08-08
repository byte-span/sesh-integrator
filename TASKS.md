# TASKS.md

Complete personal MVP implementation checklist.

## Foundation

- [x] Initialize pnpm + TypeScript + ESM
- [x] Enable strict TypeScript
- [x] Add build, typecheck, test, and formatting scripts
- [x] Add the eight-command CLI
- [x] Keep the module set small

## Runtime data and registration

- [x] Create the separate `~/.codex-handoff/` namespace
- [x] Implement idempotent `init`, JSON config/state, and atomic writes
- [x] Implement `register` with real repository/common-dir resolution
- [x] Detect and store the default branch
- [x] Prevent duplicate registrations
- [x] Default to `codex-handoff/integration`
- [x] Optionally auto-configure safe package validation scripts without overwriting existing commands
- [x] Detect, store, and run centralized worktree setup commands for registered repositories
- [x] Keep auto-detected setup advisory at begin while requiring explicit and integration setup

## Session start

- [x] Implement `begin`
- [x] Reject dirty/integration worktrees and duplicate active sessions, with an explicit strict opt-out for detached/default branches
- [x] Let the workflow safely auto-create a unique task branch from clean detached/default-branch worktrees
- [x] Record worktree, branch, start commit, integration HEAD, timestamp, summary, and dependencies
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
- [x] Persist a prompt containing timing, summaries, commits, conflicts, later integrations, dependencies, `AGENTS.md`, and conflict instructions
- [x] State that timestamps are context and do not determine precedence
- [x] Verify all conflicts are resolved and staged
- [x] Run integration validation commands in order and stop on first failure
- [x] Commit only after successful validation
- [x] Run post-integration commands only after the integration branch advances
- [x] Preserve post-integration failures and the already-advanced commit for review
- [x] Record the integration commit/result or `needs_review` error
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

## Legacy audit

- [x] Implement read-only `audit-legacy`
- [x] Detect likely source, runtime, skill, global instruction/config, LaunchAgent, launchctl, hook, branch, and worktree artifacts
- [x] Print `FOUND` / `NOT FOUND` / `UNKNOWN` and safe disable guidance
- [x] Never edit or delete legacy components

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
- [x] Dirty interrupted integration makes stale-lock recovery conservative
- [x] Legacy audit does not mutate legacy fixtures
- [x] Doctor ready/failure paths do not mutate runtime or home fixtures

## Documentation

- [x] Exact install, CLI, configuration, and test commands
- [x] Disposable manual trial
- [x] Old daemon audit/disable and rollback guidance
- [x] Known limitations
