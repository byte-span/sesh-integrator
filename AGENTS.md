# AGENTS.md

## Project

Build a new personal tool named **codex-handoff**.

This project must remain separate from the existing watcher/daemon project at:

```text
~/Developer/tools/codex-integrator
```

Do not refactor, delete, or overwrite the existing `codex-integrator` source tree.

## Goal

`codex-handoff` is a one-shot Git integration tool for Codex CLI sessions. The
CLI is the primary interface; global instructions and the bundled skill
coordinate the same lifecycle without relying on application-specific execution
mode labels.

Flow:

```text
Codex CLI task starts in an existing checkout
→ inspect or begin the handoff session and record the base commit
→ Codex works
→ Codex creates a focused commit and validates its task
→ Codex runs `codex-handoff integrate`
→ tool acquires repo lock
→ merge exact session commit into dedicated integration worktree
→ Codex resolves conflicts if necessary
→ run integration checks
→ commit successful integration
→ atomically promote the validated commit to the configured target branch
→ run post-integration checks from the target branch worktree
→ exit
```

There is no permanent watcher, polling loop, queue daemon, LaunchAgent, or background process.

## Self-hosting workflow

Do not register this repository with `codex-handoff`; it is intentionally
self-managed to avoid depending on the executable while modifying it.

For changes to this repository, work and commit directly on local `dev`, then
run the normal validation suite and rebuild `dist`. Push `dev` without force.
If no open `dev` to `main` pull request exists, open one. If one already exists,
push the exact completed `dev` commit to a unique remote branch such as
`codex/handoff-<timestamp-or-task-id>` and open a new pull request from that
branch to `main`. Never reuse, update, close, merge, delete, or force-push an
existing pull request or remote branch for a different task.

Every pull request opened for this repository must request review from
`scram-j`. Pass `--reviewer scram-j` to `gh pr create`, or immediately add the
review request with `gh pr edit <pr-url> --add-reviewer scram-j`.

Do not run parallel code-changing sessions directly on `dev` in this repository.

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
codex-handoff doctor
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
├── source-worktrees/
└── worktrees/
```

Never reuse `~/.codex-integrator/`.

## Staging and Target Branches

The internal staging branch defaults to:

```text
codex-handoff/integration
```

Do not reuse the old daemon's integration branch by default.

A repository may override it in config. The final `targetBranch` is separate,
defaults to the registered `defaultBranch`, and may also be overridden per
repository.

## Session Start

For most code-changing tasks in a Git repository, use `codex-handoff`. Skip it
for read-only work, non-Git directories, and work on this `codex-handoff`
repository itself. Do not gate the workflow on application mode metadata or
require a linked worktree.

Operate autonomously by default. Registration and normal lifecycle commands do
not require routine approval. If a repository is unregistered, run
`codex-handoff register --auto-config` and continue. Before beginning, inspect
`codex-handoff status`: continue an active or recoverable session attached to
the current checkout when it belongs to the same task; otherwise begin a new
session. Never replace or overwrite a session for a different task.

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

For Codex CLI tasks, run
`codex-handoff begin --create-worktree --summary "..."`. From an ordinary
checkout it creates a unique task branch in a separate, tool-managed source
worktree under `~/.codex-handoff/source-worktrees/`, records both the launch and
source paths, and prints the source path. All subsequent edits and lifecycle
commands must run from that source path. If the session already starts in a
linked worktree, `--create-worktree` reuses it instead of nesting another one.

Without `--create-worktree`, `begin` retains its in-place behavior: it creates
and switches to a task branch when detached or on the registered default/target
branch and leaves an existing non-default branch in place. Allow explicit
strict rejection with `--no-auto-branch`; it cannot be combined with
`--create-worktree`.

Reject:

- staged baseline changes, indeterminate Git state, or setup-created changes
- integration branch
- unregistered repo
- duplicate active session for the same worktree

When a separate source worktree is created, pre-existing staged and unstaged
changes in the launch checkout remain untouched and are excluded from the task.
For in-place or already-linked sessions, pre-existing unstaged changes may
remain only under the observable-baseline rules: they must stay unchanged and
outside the task commit. Never reset, overwrite, discard, clean, or silently
stash user changes, and never switch branches manually to bypass a blocked
`begin`.

Session start time is context, not precedence.

## Session Completion / Integration

The Codex CLI workflow is responsible for validating and creating a focused
source-branch commit before invoking:

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
9. On conflict, preserve the merge for the current Codex session.
10. Resume after the current session resolves and stages the conflict.
11. Run configured integration validation.
12. Commit the successful staging integration.
13. Atomically promote the exact validated commit to the target branch while
    verifying the expected previous target commit.
14. Synchronize a clean checked-out target worktree without losing user state,
    or record `promotion_pending` with recovery guidance.
15. Run configured post-integration checks from that target worktree.
16. Record success only after those checks pass.
17. Release the lock and exit.

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
- successful target promotions that happened after the incoming session began
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

- merge or validate inside a user target worktree
- advance a target ref without verifying its expected previous commit
- leave a checked-out target ref ahead of its index and working tree
- push automatically unless the user clearly requests it
- force-push unless the user clearly requests it
- deploy or perform destructive remote actions unless the user clearly requests
  the specific action
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

The global policy and skill must be CLI-first. They record or continue the task
session, automatically register unregistered repositories with `--auto-config`,
and run focused commit, validation, one-shot integration, conflict-resume, and
`promotion_pending` recovery without depending on application mode metadata or
routine approval prompts.

The skill must preserve unrelated and dirty user state. It may continue an
appropriate session, but must not start a duplicate. After creating a managed
source worktree it must perform all task work from the path printed by `begin`.

It must not call the old `codex-integrator`.

## Delivery

Build the entire MVP in one pass, but prove it with disposable Git repositories before recommending real-project use.

Do not turn this into a production platform.

## Completion Reporting

After any code-changing task, report the session, source commit, integration
commit, target promotion, pull-request URL when present, and all required manual
follow-up steps. Requests for concision never override these required fields.
If no manual steps remain, state `No manual follow-up required.`
