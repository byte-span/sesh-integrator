# Initial Codex Implementation Prompt

Build the complete **sesh-integrator** personal MVP described by this repository.

This is a NEW tool. Do not replace or refactor the existing:

```text
~/Developer/tools/codex-integrator
```

## Before Coding

Read completely:

1. `AGENTS.md`
2. `SPEC.md`
3. `TASKS.md`
4. `LEGACY_MIGRATION.md`
5. `README.md`
6. `GLOBAL_AGENTS_SNIPPET.md`
7. `skill/sesh-integrator-workflow/SKILL.md`

Inspect Git status and preserve unrelated changes.

## Build

Implement a small TypeScript CLI named:

```text
sesh-integrator
```

Commands:

```text
init
register
begin
integrate
resume
status
reconcile
audit-legacy
doctor
```

Do NOT implement:

```text
daemon
watcher
polling service
LaunchAgent
background queue
```

## Core Workflow

### Begin

Record:

- repo/worktree
- branch
- base commit
- integration branch commit
- task start timestamp
- summary
- optional dependencies

### Integrate

At completion:

1. find active session
2. require clean source worktree
3. capture exact current commit as ready commit
4. persist ready metadata
5. acquire per-repo filesystem lock
6. wait if another one-shot integration owns it
7. use dedicated integration worktree
8. merge exact ready SHA
9. invoke Codex for conflicts when necessary
10. include session timing + relevant later integrations in the prompt
11. run integration validation
12. commit only after validation success
13. atomically promote the exact validated staging commit to the configured target branch
14. synchronize a clean checked-out target or preserve `promotion_pending`
15. run post-integration checks from that target worktree
16. persist success only after those checks pass
17. release lock and exit

## Critical Rules

- Ready/integration order is determined by lock acquisition/completion, not session start time.
- Explicit dependencies must be honored.
- Start time is conflict context only.
- Never merge mutable branch tips when a ready SHA has been captured.
- Never modify the user's source worktree during integration.
- Never push, reset a user target worktree, or advance a target ref without its expected old commit.

## Concurrent Sessions

Implement and test:

```text
Process A integrates → owns repo lock
Process B integrates → waits
A finishes
B acquires lock → integrates against A's result
```

No daemon queue.

## Sleep / Interrupted Process

Persist session + ready metadata before merge.

If a stale lock is suspected:

- inspect recorded PID
- inspect integration worktree Git state
- do not blindly delete the lock over an unfinished merge

Provide useful status/recovery guidance.

## Legacy Audit

Implement read-only:

```bash
sesh-integrator audit-legacy
```

It should inspect likely old `codex-integrator` components described in `LEGACY_MIGRATION.md`.

It must not automatically uninstall, unload, delete, or edit them.

## Skill

Preserve and install the supplied:

```text
sesh-integrator-workflow
```

The skill must:

- run `begin` before code edits
- ask to register an unregistered repo
- validate source changes before completion
- create a focused source commit when safe
- run `integrate`
- never invoke `codex-integrator`

Provide an idempotent skill installation script.

## Tests

Use disposable temporary Git repositories.

Prove:

1. begin metadata
2. clean merge
3. two simultaneous integrations serialize
4. later integration sees updated integration branch
5. conflict resolver receives session timing/context
6. session start time does not automatically win
7. explicit dependency behavior
8. failed validation prevents commit
9. unresolved conflict becomes needs_review
10. source worktrees remain untouched
11. stale/interrupted lock handling is conservative
12. audit-legacy is read-only
13. target defaults to the registered default branch and supports an override
14. dirty, inaccessible, moved, and divergent targets are preserved safely
15. historical succeeded staging commits can be audited and explicitly reconciled

Use a fake Codex executable for deterministic conflict tests.

## Finish

Run:

- formatter if configured
- typecheck
- tests
- build

Update `TASKS.md`.

Update `README.md` with the exact commands produced by the implementation.

Summarize:

- files created
- installation steps
- how to test on a disposable repo
- how to audit/disable the old daemon
- known limitations

Build the full MVP in this session.
