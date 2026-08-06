# AGENTS.md

## Project

Build a new personal tool named **codex-handoff**.

This project must remain separate from the existing watcher/daemon project at:

```text
~/Developer/tools/codex-integrator
```

Do not refactor, delete, or overwrite the existing `codex-integrator` source tree.

## Goal

`codex-handoff` is a one-shot Git integration tool coordinated by one Codex skill.

Flow:

```text
Codex session starts
→ skill records session/base commit
→ Codex works
→ Codex validates and commits its task
→ skill runs `codex-handoff integrate`
→ tool acquires repo lock
→ merge exact session commit into dedicated integration worktree
→ Codex resolves conflicts if necessary
→ run integration checks
→ commit successful integration
→ exit
```

There is no permanent watcher, polling loop, queue daemon, LaunchAgent, or background process.

## Read First

Before implementing, read:

1. `SPEC.md`
2. `TASKS.md`
3. `LEGACY_MIGRATION.md`
4. `README.md`
5. `skill/codex-handoff-workflow/SKILL.md`

## Technical Direction

- TypeScript
- Node.js
- pnpm
- ESM
- Strict TypeScript
- Minimal dependencies
- Vitest for focused tests
- `node:child_process` / `spawn` with argument arrays
- JSON for global configuration and lightweight state
- Per-repository filesystem lock

Do not use a database.

## CLI

Implement:

```text
codex-handoff init
codex-handoff register [repo-path]
codex-handoff begin [--summary "..."] [--depends-on <session-id>]
codex-handoff integrate [--summary "..."]
codex-handoff status
codex-handoff audit-legacy
```

Optional only if it remains small:

```text
codex-handoff abort-session
```

Do not add a `run`, `daemon`, `watch`, or background-service command.

## Global Data

Use a new namespace:

```text
~/.codex-handoff/
├── config.json
├── state.json
├── sessions/
├── locks/
├── logs/
└── worktrees/
```

Never reuse `~/.codex-integrator/`.

## Integration Branch

Default:

```text
codex-handoff/integration
```

Do not reuse the old daemon's integration branch by default.

A repository may override it in config.

## Session Start

`codex-handoff begin` records:

- session ID
- repository path
- worktree path
- branch
- start commit
- integration-branch commit at start, if it exists
- start timestamp
- task summary
- optional dependencies

Reject:

- dirty worktree
- detached HEAD
- default branch
- integration branch
- unregistered repo
- duplicate active session for the same worktree

Session start time is context, not precedence.

## Session Completion / Integration

The Codex skill is responsible for validating and creating a focused source-branch commit before invoking:

```bash
codex-handoff integrate --summary "<completion summary>"
```

`integrate` must:

1. Find the active session for the current worktree.
2. Require a clean source worktree.
3. Capture the exact current commit as `readyCommit`.
4. Record ready timestamp and completion summary.
5. Acquire a per-repository lock.
6. Wait if another `codex-handoff` process is integrating the same repo.
7. Create/reuse a dedicated integration worktree.
8. Merge the exact `readyCommit`.
9. Resolve conflicts with `codex exec` if needed.
10. Run configured integration validation.
11. Commit successful integration.
12. Record result.
13. Release the lock.
14. Exit.

No polling.

## Concurrent Finishes

If two sessions finish close together in the same repository:

```text
Session A integrate → gets lock
Session B integrate → waits
Session A finishes → releases lock
Session B gets lock → merges against updated integration branch
```

This replaces the daemon queue.

Use a bounded wait with clear status output.

The lock must contain enough metadata to diagnose the owner:

- PID
- hostname
- startedAt
- session ID

If the lock appears stale, do not blindly delete it while a Git merge may be in progress. Inspect the owning process and integration worktree state first.

## Conflict Resolution Context

When a merge conflicts, provide Codex with:

- incoming task summary
- completion summary
- source branch
- start commit
- ready commit
- start time
- ready time
- conflicted files
- integration branch HEAD
- successful integrations that happened after the incoming session began
- their summaries and timestamps
- explicit dependencies
- repository `AGENTS.md`
- repository conflict instructions

Tell Codex:

- timing does not determine which implementation wins
- preserve compatible intent from both sides
- prefer validated current architecture
- do not remove behavior merely to make conflicts disappear
- leave no unresolved conflict markers
- do not commit

## Git Safety

Never:

- merge into `main` or `master`
- push automatically
- force-push
- delete user branches
- delete user worktrees
- reset a user worktree
- discard uncommitted user changes
- run integration inside the user's source worktree
- auto-commit after failed validation
- continue when conflicts remain unresolved

Merge the exact recorded commit SHA, not a moving branch tip.

## Existing Daemon System

The old `codex-integrator` system may currently have:

- a running daemon
- a LaunchAgent
- a global skill
- global `AGENTS.md` instructions
- Git hooks
- config/state directories
- an integration branch/worktree

`codex-handoff` must not silently disable or delete these.

Implement `audit-legacy` to detect likely conflicts and print recommended actions.

See `LEGACY_MIGRATION.md`.

## Skill

One global skill:

```text
codex-handoff-workflow
```

The skill records task start and runs one-shot integration at task completion.

It must not call the old `codex-integrator`.

## Delivery

Build the entire MVP in one pass, but prove it with disposable Git repositories before recommending real-project use.

Do not turn this into a production platform.
