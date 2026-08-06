# TASKS.md

Implement the complete personal MVP.

## Foundation

- [ ] Initialize pnpm + TypeScript + ESM
- [ ] Enable strict TypeScript
- [ ] Add build, typecheck, test scripts
- [ ] Add minimal CLI
- [ ] Keep module count small

## Runtime Data

- [ ] Implement `~/.codex-handoff/` paths
- [ ] Implement `init`
- [ ] Implement JSON config
- [ ] Implement lightweight JSON state
- [ ] Implement atomic file writes where practical

## Repository Registration

- [ ] Implement `register`
- [ ] Resolve Git repository root
- [ ] Detect default branch
- [ ] Prevent duplicate registrations
- [ ] Default integration branch to `codex-handoff/integration`

## Session Start

- [ ] Implement `begin`
- [ ] Detect worktree path
- [ ] Reject dirty worktree
- [ ] Reject detached HEAD
- [ ] Reject default branch
- [ ] Reject integration branch
- [ ] Record start commit
- [ ] Record integration HEAD at start
- [ ] Record task summary
- [ ] Record optional dependencies
- [ ] Prevent duplicate active session per worktree

## One-Shot Integration

- [ ] Implement `integrate`
- [ ] Find active session
- [ ] Require clean source worktree
- [ ] Capture exact ready commit
- [ ] Persist ready metadata before Git integration
- [ ] Check dependencies
- [ ] Acquire per-repo lock
- [ ] Wait cleanly if another integration holds lock
- [ ] Refresh integration state after lock acquisition

## Integration Worktree

- [ ] Create dedicated integration worktree
- [ ] Create integration branch when missing
- [ ] Never reset existing integration branch
- [ ] Refuse dirty integration worktree
- [ ] Never modify source worktree

## Merge

- [ ] Merge exact ready commit SHA
- [ ] Detect clean merge
- [ ] Detect conflicted files
- [ ] Do not merge mutable branch refs

## Conflict Resolution

- [ ] Build contextual conflict prompt
- [ ] Include session start/ready timestamps
- [ ] Include task/completion summaries
- [ ] Include same-repo integrations after session start
- [ ] Include explicit dependencies
- [ ] Include repo `AGENTS.md`
- [ ] Include repo conflict instructions
- [ ] State explicitly that timestamps do not determine precedence
- [ ] Invoke Codex non-interactively
- [ ] Verify no unmerged paths remain

## Validation / Commit

- [ ] Run source validation through skill workflow
- [ ] Run integration validation inside integration worktree
- [ ] Stop on first failed command
- [ ] Commit only after all integration checks pass
- [ ] Record integration commit and timestamp
- [ ] Mark failed conflicts/checks `needs_review`

## Lock Reliability

- [ ] Atomic lock acquisition
- [ ] Lock owner metadata
- [ ] Bounded waiting
- [ ] Clear output while waiting
- [ ] Detect obviously dead owner
- [ ] Inspect integration worktree before stale-lock recovery
- [ ] Release lock in controlled cleanup path

## Status

- [ ] Implement `status`
- [ ] Show active sessions
- [ ] Show succeeded / needs_review
- [ ] Show current lock owner
- [ ] Show integration worktree
- [ ] Show latest error

## Legacy Audit

- [ ] Implement read-only `audit-legacy`
- [ ] Detect old source directory
- [ ] Detect old runtime state directory
- [ ] Detect old skill
- [ ] Detect global AGENTS references
- [ ] Detect likely LaunchAgent
- [ ] Detect running launchctl job
- [ ] Detect Git-hook references
- [ ] Detect integration branch collision
- [ ] Print recommended disable steps
- [ ] Never auto-delete old components

## Skill

- [ ] Preserve supplied skill design
- [ ] Install skill under `~/.agents/skills/codex-handoff-workflow`
- [ ] Skill calls `begin` before edits
- [ ] Skill validates and commits before integration
- [ ] Skill calls `integrate` at completion
- [ ] Skill never invokes `codex-integrator`

## Global Guidance

- [ ] Provide exact snippet for `~/.codex/AGENTS.md`
- [ ] Ensure it asks whether to register unconfigured repos
- [ ] Ensure it does not trigger for read-only tasks
- [ ] Ensure it invokes the new skill, not the legacy skill

## Disposable Tests

- [ ] Clean merge
- [ ] Concurrent finishes / locking
- [ ] Conflict resolution
- [ ] Integration validation failure
- [ ] Session A starts before B but integrates after B
- [ ] Dependency behavior
- [ ] Interrupted/stale lock scenario
- [ ] Legacy audit does not mutate old system
- [ ] Source worktrees remain untouched

## Final Documentation

- [ ] Update README with exact install commands
- [ ] Document how to disable old daemon after new tool passes testing
- [ ] Document rollback to old system
- [ ] List known limitations
