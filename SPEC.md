# codex-handoff — One-Shot Integration Specification

## 1. Problem

Multiple Codex sessions can work concurrently in separate Git worktrees.

The difficult part is integrating their completed changes without repeatedly:

- switching branches
- manually merging
- resolving overlapping edits
- rerunning tests
- checking which session started first
- babysitting a long-running watcher/daemon

`codex-handoff` removes the long-running daemon. Integration happens exactly when a Codex session finishes.

## 2. Architecture

```text
SESSION 1                         SESSION 2
   │                                 │
   ├─ codex-handoff begin            ├─ codex-handoff begin
   │                                 │
   ├─ work                            ├─ work
   │                                 │
   ├─ validate + commit              ├─ validate + commit
   │                                 │
   └─ codex-handoff integrate        └─ codex-handoff integrate
                 │                              │
                 └────────────┬─────────────────┘
                              │
                     per-repository lock
                              │
                              v
                dedicated integration worktree
                              │
                    merge exact ready commit
                              │
                    ┌─────────┴─────────┐
                    │                   │
                 clean              conflict
                    │                   │
                    │       current Codex session
                    │       + handoff resume
                    │                   │
                    └─────────┬─────────┘
                              │
                       integration tests
                              │
                         commit + exit
```

## 3. Key Design Choice

There is **no daemon and no watcher**.

Each finished session starts its own one-shot integration process.

A per-repository lock serializes simultaneous completions.

This means the system has no idle background process and no polling state to maintain.

## 4. Locations

Project source:

```text
~/Developer/tools/codex-handoff/
```

Runtime data:

```text
~/.codex-handoff/
```

User skill:

```text
~/.agents/skills/codex-handoff-workflow/
```

Global Codex guidance:

```text
~/.codex/AGENTS.md
```

Existing old system remains separate:

```text
~/Developer/tools/codex-integrator/
~/.codex-integrator/
```

## 5. Configuration

Example `~/.codex-handoff/config.json`:

```json
{
  "lockWaitSeconds": 900,
  "codexCommand": "codex",
  "conflictResolutionMode": "current-session",
  "repositories": [
    {
      "path": "/Users/you/Developer/my-app",
      "integrationBranch": "codex-handoff/integration",
      "setupCommands": [["corepack", "pnpm", "install", "--frozen-lockfile"]],
      "setupCommandPolicy": "advisory",
      "sourceValidationCommands": [
        ["pnpm", "typecheck"],
        ["pnpm", "test"]
      ],
      "integrationValidationCommands": [
        ["pnpm", "typecheck"],
        ["pnpm", "test"],
        ["pnpm", "build"]
      ],
      "validationTiers": [
        {
          "name": "docs",
          "paths": ["**/*.md", "**/*.mdx", "LICENSE*", "NOTICE*"],
          "sourceValidationCommands": [],
          "integrationValidationCommands": [],
          "bypassIntegrationWorktree": true
        }
      ],
      "postIntegrationCommands": [],
      "conflictInstructions": "Preserve both task intents when compatible and follow repository AGENTS.md."
    }
  ]
}
```

All commands are argument arrays.

## 6. `init`

Create:

```text
~/.codex-handoff/
├── config.json
├── state.json
├── codex-home/
├── sessions/
├── locks/
├── logs/
└── worktrees/
```

Do not overwrite an existing config.

Current-session conflict resolution is the default and requires no nested model
call. The optional `nested-codex` compatibility mode runs with `CODEX_HOME` set
to the isolated, writable `codex-home/` directory and uses
`codex exec --sandbox workspace-write -`. Copy newer `auth.json` and
`config.toml` files from the caller's Codex home with owner-only permissions
before invoking that resolver.

## 7. `register`

Usage:

```bash
cd <repo>
codex-handoff register [--auto-config]
```

Add a repository entry using:

- real repository path
- default integration branch `codex-handoff/integration`
- empty validation command arrays
- empty conflict instructions

If already registered, show current config instead of duplicating it.

When `--auto-config` is present, detect setup commands without executing them.
Prefer an executable `scripts/bootstrap`, `scripts/setup`, or `bin/setup`, then detect common
language lockfiles. Also inspect root `package.json` scripts. Populate empty
command lists only, preserving every non-empty list:

- worktree setup: detected bootstrap or dependency setup commands
- source validation: `format:check`, `typecheck`, `lint`, `test`
- integration validation: the detected source commands followed by `build`
- post-integration: only the explicit `handoff:post-integration` script

If `handoff:source` or `handoff:integration` exists, use that explicit aggregate
script instead of the corresponding inferred list. Ignore deployment, release,
end-to-end, and other unrecognized scripts. The flag also applies safe detected
settings to an existing registration.

Registration initializes an empty post-integration command list.
Unknown ecosystems may supply repeatable JSON argument arrays with
`--setup-command` during registration.

## 8. `begin`

Usage:

```bash
codex-handoff begin --summary "Implement comment editing"
```

Optional:

```bash
codex-handoff begin \
  --summary "Add API endpoint" \
  --depends-on session_abc
```

Record:

```json
{
  "id": "session_...",
  "status": "active",
  "repositoryPath": "...",
  "worktreePath": "...",
  "branch": "codex/task-name",
  "startCommit": "...",
  "integrationCommitAtStart": "...",
  "startedAt": "...",
  "taskSummary": "...",
  "dependsOn": []
}
```

Requirements:

- repo registered
- auto-configured setup failures warn but do not block branch or session creation
- explicitly configured setup commands must succeed before branch or session creation
- observable Git baseline captured before setup, including separate status,
  raw worktree diff, staged diff, index output, stderr, and exit status
- no staged baseline changes; pre-existing unstaged changes may remain only when
  later observably unchanged and outside the task diff
- a detached/default-branch worktree is switched to a unique
  `codex/session-...` branch before the session is recorded
- `--no-auto-branch` retains strict rejection when explicitly requested
- branch is not integration branch
- no active session already attached to this worktree

## 9. Skill Completion Behavior

Before integration, the skill:

1. Reads repository instructions.
2. Inspects `git status` and diff.
3. Creates a focused source-branch commit if task changes remain uncommitted.
4. Runs `codex-handoff validate` to compare the source against its recorded
   baseline and select a path-based tier for the exact task commit range.
5. Stops if validation fails.
6. Requires no newly introduced working-tree changes; observably unchanged,
   unstaged baseline paths outside the task diff are preserved and excluded.
7. Calls:

```bash
codex-handoff validate
codex-handoff integrate --summary "Implemented edit flow and tests"
```

The CLI itself should not broadly stage arbitrary user files.

### 9.1 Tiered validation and direct trivial integration

Validation tiers are ordered and path-based. A tier matches only if every path
changed since session start matches one of that tier's patterns. No match uses
the repository's full validation commands.

A tier may explicitly request `bypassIntegrationWorktree`. The bypass requires
the exact ready commit to have passed `codex-handoff validate`, zero integration
commands for the tier, and zero post-integration commands. It still acquires the
repository lock, merges against the current integration HEAD using Git plumbing,
and atomically advances only the dedicated integration branch. Conflicts or an
unsafe tool-owned worktree fall back to normal integration. It never updates the
default branch or removes a user worktree.

## 10. `integrate`

### 10.1 Capture Ready Snapshot

Find the active session for the current worktree.

Capture:

- ready commit = current HEAD
- ready time
- completion summary

Persist this before attempting integration.

### 10.2 Dependencies

If `dependsOn` is non-empty:

- all referenced sessions must have succeeded integration
- otherwise wait/stop with a clear message
- a failed dependency blocks integration

Dependencies override timing.

### 10.3 Lock

Acquire:

```text
~/.codex-handoff/locks/<repo-id>.lock/
```

Use atomic directory creation.

Write lock metadata:

```json
{
  "pid": 12345,
  "hostname": "macbook",
  "sessionId": "session_...",
  "acquiredAt": "..."
}
```

If lock exists:

1. print who owns it
2. wait/retry until timeout
3. do not spin aggressively
4. after acquiring it, refresh integration branch state before merging

### 10.4 Integration Worktree

Use one dedicated worktree:

```text
~/.codex-handoff/worktrees/<repo-id>/
```

Rules:

- never use source worktree for integration
- worktree must be clean
- integration branch must be checked out only there
- create branch from repository default branch if it does not exist
- never reset an existing integration branch automatically

### 10.5 Merge

Merge exact SHA:

```bash
git merge --no-ff --no-commit <readyCommit>
```

Do not merge the mutable branch ref.

### 10.6 Clean Merge

If merge is clean:

1. run setup commands
2. run integration validation
3. if successful, create merge commit
4. record integration commit and timestamp
5. run post-integration commands in order after the integration branch advances
6. mark session succeeded
7. release lock
8. exit 0

If a post-integration command fails, preserve the already-advanced integration
commit and command output, mark the session `needs_review`, release the lock, and
exit non-zero. Do not run post-integration commands when the ready commit was
already present and the integration branch did not advance.

### 10.7 Conflict

Collect:

```bash
git diff --name-only --diff-filter=U
```

Build a conflict prompt containing:

- incoming session metadata
- conflicted files
- integration HEAD
- repository `AGENTS.md`
- repository conflict instructions
- all same-repo sessions integrated after this session's `startedAt`
- explicit dependencies

Persist the prompt and merge metadata, release the lock, and instruct the
current Codex session to resolve and stage the integration worktree. The skill
then invokes `codex-handoff resume` from the source worktree. `resume` reacquires
the lock and verifies the source snapshot, integration branch and HEAD,
`MERGE_HEAD`, and absence of unmerged paths before continuing.

Optional `nested-codex` mode invokes a non-interactive Codex command in the
integration worktree instead.

After resolution:

1. verify there are zero unmerged paths
2. run integration validation
3. commit only on success

If unresolved or validation fails:

- preserve integration worktree
- mark `needs_review`
- keep enough state/logs to diagnose
- release lock only after state is persisted
- exit non-zero

## 11. Out-of-Order Sessions

Example:

```text
12:00 Session A starts
12:05 Session B starts
12:10 Session B integrates successfully
12:15 Session A finishes and conflicts
```

Session A's conflict prompt should mention that Session B was integrated after Session A began.

This is useful context.

It must **not** say Session A wins because it started first.

## 12. `status`

Show:

- active sessions
- waiting integrations
- succeeded integrations
- `needs_review`
- lock owner
- integration worktree path
- start time / ready time / integrated time
- latest error

Keep it simple.

## 13. `doctor`

Run one read-only readiness check from the intended project worktree.

Check:

- Node.js, Git, and the configured Codex executable
- runtime and configuration integrity
- installed workflow skill and global guidance synchronized with the bundled
  policy and free of stale detached/default-branch prohibitions
- current repository registration
- configured source and integration validation commands
- active integration locks
- likely active legacy automation

Print `READY`, `READY WITH ... WARNINGS`, or `NOT READY`. Exit nonzero for
missing required readiness conditions. Do not mutate runtime, configuration,
Git state, or legacy components.

## 14. `audit-legacy`

Read-only by default.

Check for likely old-system components:

```text
~/Developer/tools/codex-integrator
~/.codex-integrator
~/.agents/skills/codex-integrator-workflow
~/.codex/AGENTS.md references to codex-integrator
~/.codex/config.toml disabled/enabled old skills
~/Library/LaunchAgents/*codex*integrator*.plist
launchctl jobs containing codex/integrator
Git hooks or core.hooksPath references to codex-integrator
existing codex/integration worktrees/branches
```

Print:

```text
FOUND / NOT FOUND / UNKNOWN
```

For each found component, explain whether it can conflict with `codex-handoff`.

Do not disable anything automatically.

## 15. Failure / Sleep Behavior

The tool is intentionally one-shot.

If the Mac sleeps while a one-shot integration is running, the process may pause and resume after wake.

If the process dies:

- session and ready metadata were already persisted
- the lock metadata identifies the interrupted process
- `status` should surface the state
- a later retry must inspect Git merge state before taking action

Do not blindly restart a merge over an existing unresolved merge state.

## 16. Acceptance Criteria

The MVP is ready when disposable repo tests prove:

1. `begin` records a clean session snapshot.
2. Source validation can block integration.
3. `integrate` captures exact ready commit.
4. A clean merge succeeds.
5. Two simultaneous integrations serialize via the lock.
6. Later integration sees the first integration's changes.
7. Session timing appears in conflict context.
8. Start time never automatically decides precedence.
9. A conflict can be resolved through a fake Codex executable.
10. Failed conflict resolution becomes `needs_review`.
11. Integration validation failure is not committed.
12. Source worktrees are untouched.
13. Old daemon components are only audited, never silently removed.
14. Post-integration commands run only after the integration branch advances.
15. A post-integration failure preserves the advanced commit and command result.
16. `doctor` reports both ready and actionable not-ready states without mutation.
17. Setup runs before session creation and before integration validation.
18. Auto-configured setup failure does not block `begin`; explicit setup failure does.
19. A preserved conflict can be resolved by the current session and completed with `resume`.
