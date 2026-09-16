# AGENTS.md

## Project

Build a personal tool named **sesh-integrator**, with **`seshx`** as its
preferred CLI command. Keep `sesh-integrator`, `pintx`, `parallel-integrator`, and `codex-handoff` as
compatibility commands.

This project must remain separate from the existing watcher/daemon project at:

```text
~/Developer/tools/codex-integrator
```

Do not refactor, delete, or overwrite the existing `codex-integrator` source tree.

## Goal

`sesh-integrator` is a one-shot Git integration tool for Codex CLI sessions. The
CLI is the primary interface; global instructions and the bundled skill
coordinate the same lifecycle without relying on application-specific execution
mode labels.

Flow:

```text
Codex CLI task starts in an existing checkout
→ inspect or begin the handoff session and record the base commit
→ Codex works
→ Codex creates a focused commit and validates its task
→ Codex runs `seshx integrate`
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

Use the normal session workflow for this repository, with isolated source
worktrees and local `dev` as the target. Never run parallel code-changing
sessions directly on `dev`. Local task branches are expected; only `dev` is
published for the shared `dev` to `main` pull request.

The coordinator must be a stable snapshot outside every development worktree.
See README's "Developing sesh-integrator concurrently" section. Resolve and
record its real CLI path before beginning, and use `node "$SESH_COORDINATOR"`
for every lifecycle command, including recovery. Never use a task's `dist/cli.js`
to coordinate its own integration. Build and test candidate code in the task
worktree. Do not replace a coordinator while its sessions are unfinished;
retain old releases for recovery and coordinate schema changes before upgrading.

Register with `--auto-config` and explicitly target `dev`. An explicitly configured
`promotion.type: "pull-request"` authorizes the integrator to push `dev` without
force and create or update its `dev` to `main` pull request. Otherwise keep
promotion local unless pushing is requested. Direct agent-issued pushes,
force-pushes, and PR merges still require an explicit user request.
Resolve conflicts in the current agent session,
validate, and resume using the pinned coordinator. Keep dirty launch-checkout
state untouched; it can defer target promotion until its owner finishes.

After configured PR promotion or an explicitly requested push, reuse the existing open `dev` to `main`
pull request or create one if absent. Never push task branches, close or merge
pull requests, or delete or force-push remote branches without explicit user
instructions.

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
5. `skill/sesh-integrator-workflow/SKILL.md`

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
seshx init
seshx register [repo-path]
seshx begin [--summary "..."] [--depends-on <session-id>]
seshx integrate --summary "..." --rollout <none|applied|automated|manual> [--follow-up "..."]...
seshx status
seshx audit-legacy
seshx doctor
```

Optional only if it remains small:

```text
seshx abort-session
```

Do not add a `run`, `daemon`, `watch`, or background-service command.

## Global Data

Use a new namespace:

```text
~/.sesh-integrator/
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
sesh-integrator/integration
```

Do not reuse the old daemon's integration branch by default.

A repository may override it in config. The final `targetBranch` is separate,
resolves in this order: an explicit repository `targetBranch`, the global
`defaultTargetBranch`, then the registered `defaultBranch`.

## Session Start

For most code-changing tasks in a Git repository, use `sesh-integrator`. Skip it
for read-only work and non-Git directories. For this repository, use the stable
coordinator described above. Do not gate the workflow on application mode metadata or
require a linked worktree.

Operate autonomously by default. Registration and normal lifecycle commands do
not require routine approval. If a repository is unregistered, run
`seshx register --auto-config` and continue. Before beginning, inspect
`seshx status`: continue an active or recoverable session attached to
the current checkout when it belongs to the same task; otherwise begin a new
session. Never replace or overwrite a session for a different task.

`seshx begin` records:

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
`seshx begin --create-worktree --summary "..."`. From an ordinary
checkout it creates a unique task branch in a separate, tool-managed source
worktree under `~/.sesh-integrator/source-worktrees/`, records both the launch and
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
seshx integrate --summary "<completion summary>" --rollout <none|applied|automated|manual> [--follow-up "<required action>"]...
```

`integrate` must:

1. Find the active session for the current worktree.
2. Require a clean source worktree.
3. Capture the exact current commit as `readyCommit`.
4. Record ready timestamp, completion summary, and the mandatory external-state
   rollout classification. Manual rollout requires explicit follow-up actions.
5. Acquire a per-repository lock.
6. Wait if another `sesh-integrator` process is integrating the same repo.
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
- issue a direct Git push without an explicit user request; configured integrator
  PR promotion is authorized as described above
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

`sesh-integrator` must not silently disable or delete these.

Implement `audit-legacy` to detect likely conflicts and print recommended actions.

See `LEGACY_MIGRATION.md`.

## Skill

One global skill:

```text
sesh-integrator-workflow
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
