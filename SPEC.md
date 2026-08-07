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
                    │             codex exec
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
  "repositories": [
    {
      "path": "/Users/you/Developer/my-app",
      "integrationBranch": "codex-handoff/integration",
      "sourceValidationCommands": [
        ["pnpm", "typecheck"],
        ["pnpm", "test"]
      ],
      "integrationValidationCommands": [
        ["pnpm", "typecheck"],
        ["pnpm", "test"]
      ],
      "postIntegrationCommands": [["pnpm", "build"]],
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
├── sessions/
├── locks/
├── logs/
└── worktrees/
```

Do not overwrite an existing config.

## 7. `register`

Usage:

```bash
cd <repo>
codex-handoff register
```

Add a repository entry using:

- real repository path
- default integration branch `codex-handoff/integration`
- empty validation command arrays
- empty conflict instructions

If already registered, show current config instead of duplicating it.

Registration initializes an empty post-integration command list.

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
- worktree clean
- branch is not detached
- branch is not repo default branch
- branch is not integration branch
- no active session already attached to this worktree

## 9. Skill Completion Behavior

Before integration, the skill:

1. Reads repository instructions.
2. Inspects `git status` and diff.
3. Runs `sourceValidationCommands`.
4. Stops if validation fails.
5. Creates a focused source-branch commit if task changes remain uncommitted.
6. Requires the worktree to be clean.
7. Calls:

```bash
codex-handoff integrate --summary "Implemented edit flow and tests"
```

The CLI itself should not broadly stage arbitrary user files.

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

1. run integration validation
2. if successful, create merge commit
3. record integration commit and timestamp
4. run post-integration commands in order after the integration branch advances
5. mark session succeeded
6. release lock
7. exit 0

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

Invoke Codex in the integration worktree.

Use a non-interactive command supported by the installed Codex version, with the integration worktree as cwd.

After Codex returns:

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

## 13. `audit-legacy`

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

## 14. Failure / Sleep Behavior

The tool is intentionally one-shot.

If the Mac sleeps while a one-shot integration is running, the process may pause and resume after wake.

If the process dies:

- session and ready metadata were already persisted
- the lock metadata identifies the interrupted process
- `status` should surface the state
- a later retry must inspect Git merge state before taking action

Do not blindly restart a merge over an existing unresolved merge state.

## 15. Acceptance Criteria

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
