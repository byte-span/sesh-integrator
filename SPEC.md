# sesh-integrator — One-Shot Integration Specification

The preferred executable is `seshx`. The npm package remains `sesh-integrator`;
`sesh-integrator`, `pintx`, `parallel-integrator`, and `codex-handoff` are compatibility executables pointing
to the same CLI. Existing runtime paths, configuration variables, and Git refs remain supported; fresh installations use the new defaults described in README.md.

## 1. Problem

Multiple Codex sessions can work concurrently in separate Git worktrees.

The difficult part is integrating their completed changes without repeatedly:

- switching branches
- manually merging
- resolving overlapping edits
- rerunning tests
- checking which session started first
- babysitting a long-running watcher/daemon

`sesh-integrator` removes the long-running daemon. Integration happens exactly when a Codex session finishes.

## 2. Architecture

```text
SESSION 1                         SESSION 2
   │                                 │
   ├─ seshx begin            ├─ seshx begin
   │                                 │
   ├─ work                            ├─ work
   │                                 │
   ├─ validate + commit              ├─ validate + commit
   │                                 │
   └─ seshx integrate        └─ seshx integrate
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
                      staging commit
                              │
                   atomic target promotion
                              │
             post-integration checks on target + exit
```

## 3. Key Design Choice

There is **no integration daemon or background watcher**.
The interactive dashboard watches saved session/configuration files only while
open, with a 30-second fallback refresh; it never triggers integration automatically.

Each finished session starts its own one-shot integration process.

A per-repository lock serializes simultaneous completions.

If an earlier integration preserves conflicts or failed validation in the
canonical integration worktree, later sessions use detached session-owned
integration worktrees. A validated isolated result advances the staging ref
with an expected-old check, so preserved review state does not monopolize the
repository.

This means integration has no idle background process or polling state to maintain.

## 4. Locations

Project source:

```text
~/Developer/tools/sesh-integrator/
```

Runtime data:

```text
~/.sesh-integrator/
```

Every integration attempt first creates a session-isolated recovery bundle in
`recovery-bundles/<session>/<attempt>/` and write-once Git refs below
`refs/codex-handoff/recovery/<session>/<attempt>/`. The manifest is hash chained
and records the base, exact source, target baseline, rollout contract, conflict
index snapshots, merged trees, validation outcomes, and validated staging
commit. Resume verifies these objects and reconstructs a fresh detached
`recovery-worktrees/<session>/<attempt>/` checkout; the shared integration
worktree and current source branch are never recovery authorities.

Open bundles are never removed by routine cleanup. Successful promotion marks
the bundle archived while retaining its immutable refs and evidence. Older
session files without bundle metadata are migrated on first resume by capturing
their preserved state before reconstruction. Explicit archival/deletion policy
may be added separately; age alone must never make a failed session
unrecoverable.

User skill:

```text
~/.agents/skills/sesh-integrator-workflow/
```

Global Codex guidance:

```text
~/.codex/AGENTS.md
```

Installers synchronize only global guidance and the workflow skill. They must
not create or modify repository `AGENTS.md` files. Repository instructions are
optional, remain project-owned, and are read for conflict context. Doctor does
not require or compare repository-managed guidance blocks.

Existing old system remains separate:

```text
~/Developer/tools/codex-integrator/
~/.codex-integrator/
```

## 5. Configuration

Example `~/.sesh-integrator/config.json`:

```json
{
  "lockWaitSeconds": 900,
  "codexCommand": "codex",
  "conflictResolutionMode": "current-session",
  "defaultTargetBranch": "dev",
  "defaultPromotion": {
    "reviewers": ["scram-j"],
    "assignees": ["scram-j"]
  },
  "repositories": [
    {
      "path": "/Users/you/Developer/my-app",
      "defaultBranch": "main",
      "integrationBranch": "sesh-integrator/integration",
      "targetBranch": "main",
      "promotion": {
        "type": "pull-request",
        "productionBranch": "main",
        "remote": "origin",
        "reviewers": ["platform-team"],
        "assignees": ["release-owner"]
      },
      "gpgProgram": "/Users/you/.local/bin/codex-gpg",
      "setupCommands": [["corepack", "pnpm", "install", "--frozen-lockfile"]],
      "setupCommandPolicy": "advisory",
      "validationCache": "session",
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

Commands are argument arrays. Validation lists may also contain explicit
`{"parallel": [<command>, ...]}` groups whose members run concurrently.
Any validation command may instead use a declarative object:

```json
{
  "command": ["tool", "check"],
  "resources": {
    "shared": ["service:read-only"],
    "exclusive": ["workspace:mutable-fixture"]
  },
  "failure": {
    "classification": "transient",
    "maxAttempts": 3,
    "initialBackoffMs": 250,
    "maxBackoffMs": 2000
  }
}
```

Resource keys are opaque, tool-agnostic strings. Commands holding compatible
shared leases may overlap; an exclusive lease conflicts with every lease for
the same key. Keys are acquired in sorted order and held only for that command,
so conflicting source and integration validations serialize across repositories
and sessions without serializing unrelated work.

Failures default to unclassified and run once. A non-zero exit is preserved as
evidence, never promoted to a deterministic verdict. Explicitly transient
failures retry with bounded exponential backoff (three attempts by default).
Every integration validation failure preserves the exact merge and command
metadata in `validation_pending`; `resume` reacquires resources and reruns the
unchanged validation after the agent assesses the evidence. Legacy
`deterministic` declarations remain readable but are treated as unclassified.

`defaultTargetBranch` is an optional global policy. Target resolution uses an
explicit repository `targetBranch` first, then `defaultTargetBranch`, then the
registered `defaultBranch`. Changing the global value therefore migrates all
existing registrations that omit `targetBranch` without rewriting them, while
preserving explicit per-repository exceptions. Omitting the global setting
retains the backward-compatible default-branch behavior.

Remote promotion defaults to `{ "type": "none" }`. A repository may opt into
`pull-request` promotion after successful local promotion and post-integration
checks. The tool pushes the effective target to `origin` by default, then
creates or reuses an open PR into `productionBranch` (defaulting to
`defaultBranch`). Configured reviewers are requested and configured assignees
are assigned; CODEOWNERS review requests remain managed by GitHub. Global
`defaultPromotion.reviewers` and `defaultPromotion.assignees` apply to every
repository using pull-request promotion. A repository may override either list
independently, including with an empty list to disable that global default.

Pull-request promotion supports two modes. Omitted `mode` and explicit
`"shared-target"` preserve the original behavior: push the effective target and
reuse the open PR for that target/base pair. Explicit `"session-branch"` pushes
the exact session `readyCommit` to its recorded source branch and creates a PR
from that branch to `productionBranch`. Multiple session PRs may remain open.
Retries may reuse only a PR with the same head and persisted session marker and
must refuse an unrelated PR on that head.

Both modes validate Git branch names, configured remote existence, GitHub CLI
authentication, remote base existence, and distinct base/head commits. Neither
mode force-pushes, merges, closes, or deletes a remote branch or PR. The session
persists the PR URL for status and recovery output; doctor reports promotion
mode and readiness.

For shared-target promotion only, a rejected non-force push may recover when
the fetched remote target is provably descended from the session's recorded
target baseline. Merge that exact fetched commit into the validated integration
branch, preserve conflicts for current-session resolution, run full integration
validation and post-integration checks again, atomically advance the local
target, and retry the non-force push at most three times. Persist the fetched
commit, original remote baseline, attempt count, and recovery phase before
merging so interruption remains resumable.

Fetch the shared remote target under the repository lock immediately before
recording the integration baseline. Fast-forward local target state to a normal
remote advancement before merging the session. Treat a fetched tip that has
replaced or diverged from the locked baseline as rewritten history and stop
without pushing. Hosting branch protection must prohibit force pushes and
deletion and require fast-forward-compatible shared-target updates.

## 6. `init`

Create:

```text
~/.sesh-integrator/
├── config.json
├── state.json
├── codex-home/
├── sessions/
├── indexes/
├── performance/
├── cache/
├── recovery-bundles/
├── recovery-worktrees/
├── locks/
├── logs/
├── source-worktrees/
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
seshx register [--auto-config]
```

Add a repository entry using:

- real repository path
- registered default branch
- internal integration branch `sesh-integrator/integration`
- no explicit target override, so the effective target is the global
  `defaultTargetBranch` when configured, otherwise `defaultBranch`
- empty validation command arrays
- empty conflict instructions

If already registered, show current config instead of duplicating it.

When a global `defaultTargetBranch` applies, registration and the pre-session
readiness check must ensure that target exists locally without switching the
user's checkout: reuse the local branch, create a tracking branch from the
matching remote branch, or create it from the registered default branch. Refuse
with actionable guidance when the default branch is unborn or the target cannot
be created safely. Never push the created branch automatically.

An existing entry without `targetBranch` remains valid and follows the global
`defaultTargetBranch` when configured, otherwise `defaultBranch`, except when
its `integrationBranch` already equals `defaultBranch` or the effective global
target. That historical state is ambiguous and must be rejected with a
migration message rather than guessed.

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

### Repository enablement

`seshx disable [repo-path]` and `seshx enable [repo-path]` default to the
current directory, including subdirectories. Store canonical Git common-dir
paths in optional global `disabledRepositories: string[]`, independently of
registration; cover linked worktrees and unborn/unregistered repositories.
Registration preserves opt-outs and skips target creation while disabled.
Enablement changes preserve all repository settings, sessions, and Git state.
Serialize CLI config mutations so registration cannot overwrite an opt-out.

Reject begin, commit, validate, integrate, resume, and reconcile apply while
disabled. Keep inspection available and show registration and enablement
separately in status. The workflow checks status before automatic registration
or recovery and must not enable without a user request.

Enablement changes acquire the repository lock without waiting or stale-lock
reclamation, refusing any existing integration lock. Integrate/resume recheck
fresh enablement under that lock before mutating integration state. Source
commands already running are not cancelled.

## 8. `begin`

Usage:

```bash
seshx begin --create-worktree --summary "Implement comment editing"
```

Optional:

```bash
seshx begin \
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
- `--create-worktree` creates a unique task branch and linked source worktree
  under the runtime when invoked from an ordinary checkout
- an already-linked checkout is reused rather than nested
- the launch checkout, including staged and unstaged user state, is not modified
- output identifies the source path that the Codex CLI session must use for all
  subsequent edits and lifecycle commands
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
- no active session already attached to the selected source worktree
- active sessions launched earlier from the same ordinary checkout do not block
  another `--create-worktree` task; each receives a unique branch and worktree

Source lifecycle commands infer the session from the current source worktree for
backward compatibility. `commit`, `validate`, `integrate`, and `resume` also
accept `--session <session-id>`. From a shared launch checkout, one matching
managed session may be inferred; multiple matches require explicit selection.

## 9. Skill Completion Behavior

The workflow is CLI-first and applies to most code-changing work in Git
repositories. It excludes read-only work, non-Git directories, this repository,
and the integration branch. It does not depend on application mode labels. It
automatically registers an unregistered repository with `--auto-config`,
continues an appropriate active session, or begins with `--create-worktree`.
After begin, the session performs every edit and lifecycle command from the
recorded source path.

Before integration, the skill:

1. Reads repository instructions.
2. Inspects `git status` and diff.
3. Stages only intended task paths and creates a focused source-branch commit
   with `seshx commit --message "..."` if task changes remain
   uncommitted. When signing is enabled, this performs a real OpenPGP preflight
   immediately before the commit and scopes the configured GPG program to Git.
4. Runs `seshx validate` to compare the source against its recorded
   baseline and select a path-based tier for the exact task commit range.
5. Stops if validation fails.
6. Requires no newly introduced working-tree changes; observably unchanged,
   unstaged baseline paths outside the task diff are preserved and excluded.
7. Calls:

```bash
seshx validate
seshx integrate --summary "Implemented edit flow and tests" --rollout none
```

The CLI itself should not broadly stage arbitrary user files.

Completion output preserves every recorded follow-up in full, with a count and
an instruction to retain each action, destination, and exact configuration name
in the final response. Follow-ups remain backward-compatible strings, never
credential values. The agent verifies actionability and completeness; the CLI
cannot inspect the final assistant response. Links may supplement but not
replace known steps. Integration failures and `status --session` report current
prerequisites separately from external follow-ups. Successful recovery removes
resolved blockers without treating external actions as completed. Missing legacy
rollout metadata cannot justify “No manual follow-up required.” Automated rollout
means delegated, not verified applied.

### 9.1 Tiered validation and direct trivial integration

Validation tiers are ordered and path-based. A tier matches only if every path
changed since session start matches one of that tier's patterns. No match uses
the repository's full validation commands.

A tier may explicitly request `bypassIntegrationWorktree`. The bypass requires
the exact ready commit to have passed `seshx validate`, zero integration
commands for the tier, and zero post-integration commands. It still acquires the
repository lock, merges against the current integration HEAD using Git plumbing,
atomically advances the dedicated staging branch, and then uses the same safe
target-promotion path. Conflicts or an unsafe tool-owned worktree fall back to
normal integration. It never removes a user worktree or pushes.

Auto-configuration may add conservative documentation-only and test-only tiers
and may group independent inferred checks in explicit parallel groups.
Before a non-empty validation plan, the tool also inspects package manifests
throughout the worktree and runs conventionally safe, disposable framework
preparation when the repository's validation scripts do not already do so.
Initial conventions cover Next.js type generation, SvelteKit sync, Nuxt
prepare, Astro sync, and React Router type generation. Detection uses declared
dependencies and supported versions, works for nested monorepo packages, and
requires no repository configuration. Preparation failure stops validation;
deployment, migration, release, and generators that normally rewrite tracked
source remain excluded.
Successful validation commands are fingerprinted by exact Git tree, command,
platform, architecture, and Node version. Session-local reuse is the default;
repository-wide reuse is an explicit configuration choice. Required setup is
never cached, while auto-detected advisory JavaScript setup may be reused only
for an unchanged manifest/lockfile fingerprint and an extant dependency marker.

## 10. `integrate`

### 10.1 Capture Ready Snapshot

Find the active session for the current source worktree, or use the explicitly
selected session. A command from a launch checkout must reject multiple matching
sessions unless `--session <session-id>` is supplied.

Capture:

- ready commit = current HEAD
- ready time
- completion summary
- external-state rollout classification (`none`, `applied`, `automated`, or
  `manual`) and explicit follow-up actions for `manual`

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
~/.sesh-integrator/locks/<repo-id>.lock/
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
5. capture the current target commit as the exact expected promotion baseline

### 10.4 Integration Worktree

Use one dedicated worktree:

```text
~/.sesh-integrator/worktrees/<repo-id>/
```

Rules:

- never use source worktree for integration
- worktree must be clean
- integration branch must be checked out only there
- create the staging branch from the current target if it does not exist
- fast-forward a clean staging branch to the current target when staging is behind
- refuse staging-ahead or divergent historical state and require reconciliation
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
4. record the validated staging commit and timestamp
5. promote the exact validated staging commit to the configured target
6. run post-integration commands in order from its clean checked-out target worktree
7. mark the session succeeded only after post-integration checks pass
8. when configured, push the target and create or update its promotion PR
9. release the lock and exit 0

If the staged merge tree is identical to the source-validated tree, reuse only
matching successful command fingerprints and run every integration-only or
otherwise unmatched command. A retry may reuse a successful command only while
the exact tree and fingerprint remain unchanged.

### 10.6.1 Performance records

Measure total lifecycle time and named phases for source state, setup,
validation, lock wait, worktree preparation, merge, commit, promotion, and
post-integration checks. Persist one aggregate JSON record per session with
subprocess counts, tier/path metrics, and cache hits. Console output remains a
concise total plus the slowest phases.

The `benchmark` command uses disposable small, large, dirty, conflicting, and
concurrent repositories. It reports median, p95, and maximum tool overhead,
excluding configured project commands, and supports CI regression budgets.

Target promotion uses the target commit captured under the repository lock as
an expected-old value. If the target is not checked out and no post-integration
commands are configured, use atomic `update-ref`. If it is checked out in one accessible, clean worktree at the
expected commit, use a verified fast-forward in that worktree so its ref,
index, and files remain synchronized. Dirty, inaccessible, multiply checked
out, or unexpectedly moved targets produce `promotion_pending`; they never
discard user changes. `resume` retries only the preserved validated commit.
An explicit configuration where target and staging names are equal is supported
as a legacy-style opt-in; the validated staging ref is already the target and
must not be checked out by another worktree.

Configured post-integration commands require exactly one accessible, clean
worktree checking out the target branch. If none exists, preserve the validated
staging commit as `promotion_pending`; `resume` retries after the target is
checked out. If a post-integration command fails, preserve the already-promoted
target and command output, mark the session `needs_review`, release the lock,
and exit non-zero. `resume` reruns the checks on the target worktree. Do not run
them when the ready commit was already present and the staging branch did not
advance.

If validation or integration commit creation fails after a clean merge, `resume`
may retry only when the source snapshot and merge target still match and the
staged tree equals Git's reconstructed clean merge tree.

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
then invokes `seshx resume` from the source worktree. `resume` reacquires
the lock and verifies the source snapshot, integration branch and HEAD,
`MERGE_HEAD`, and absence of unmerged paths before continuing.

Optional `nested-agent` mode invokes the session's non-interactive harness in the
integration worktree instead.

After resolution:

1. verify there are zero unmerged paths
2. run integration validation
3. commit only on success

If unresolved or validation fails:

- preserve integration worktree
- preserve all validation failures as resumable `validation_pending`
- let the agent assess preserved evidence before choosing retry or escalation
- keep enough state/logs to diagnose
- release lock only after state is persisted
- exit non-zero
- create an immutable incident ticket with a stable failure fingerprint,
  concise diagnosis, proposed fix, scope, confidence, and preserved evidence
- print the ticket in the failure summary and offer to implement its fix in a
  separate user-approved session

Incident proposals may improve the workflow skill or global instructions, but
a failed session never edits its own policy. `seshx incident <ticket>`
is read-only and exposes the stored diagnosis for a later session. Release the
repository lock before invoking a read-only investigation with the session's harness.
Validate its response against a narrow schema; deterministic code captures
evidence, fingerprints recurrence, and enforces safety, but does not maintain a
failure-classification rule tree. An unavailable or invalid investigation
stores a neutral fallback diagnosis.

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
- validated integrations awaiting target promotion
- `needs_review`
- lock owner
- integration worktree path
- start time / ready time / integrated time
- latest error
- target branch, expected target commit, promoted commit, and recovery phase

Keep it simple.

## 13. `doctor`

Run one read-only readiness check from the intended project worktree.

Check:

- Node.js, Git, and the configured Codex executable
- runtime and configuration integrity
- installed workflow skill and global guidance synchronized with the bundled
  policy and free of stale detached/default-branch prohibitions
- current repository registration
- separate staging and effective target branches, including missing or divergent refs
- configured source and integration validation commands
- active integration locks
- likely active legacy automation

Print `READY`, `READY WITH ... WARNINGS`, or `NOT READY`. Exit nonzero for
missing required readiness conditions. Do not mutate runtime, configuration,
Git state, or legacy components.

### Explicit repository guidance cleanup

`seshx cleanup-guidance` previews removal of recognized historical
managed repository blocks across registered checkout roots. `--apply` performs
the cleanup with original-file backups under the selected runtime. Preserve
all text outside the block and remove generated-only files. Skip staged files,
symlinks, hard links, malformed or ambiguous blocks, code examples, and detected
concurrent modifications. Continue processing other repositories and exit
nonzero when any are skipped. Do not alter the Git index or refs, commit, push,
or run this operation from installers or automatic hooks.

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

For each found component, explain whether it can conflict with `sesh-integrator`.

Do not disable anything automatically.

### 14.1 `reconcile`

`seshx reconcile` is read-only by default. For each selected registered
repository it compares staging and target ancestry and finds recorded
`succeeded` integrations absent from the target. It offers a fast-forward only
when the target is an ancestor of staging, the staging head is an exact recorded
successful integration commit, and every missing recorded integration is in
that history. Divergence, staging-behind ambiguity, and unrecorded staging heads
are refused. `--apply` uses the normal checked-out-target synchronization and
atomic expected-old promotion path. It never merges, resets, deletes, or pushes.

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
14. Post-integration commands run from the checked-out target worktree only after promotion.
15. A post-integration failure preserves the promoted commit and command result.
16. `doctor` reports both ready and actionable not-ready states without mutation.
17. Setup runs before session creation and before integration validation.
18. Auto-configured setup failure does not block `begin`; explicit setup failure does.
19. A preserved conflict can be resolved by the current session and completed with `resume`.
20. A tracked baseline-inaccessible path remains safely excluded when sandboxed
    Git reports only a scoped permission warning plus a raw deletion and omits
    the path from porcelain status.
21. The bundled workflow and global guidance are CLI-first and create a managed
    source worktree from an ordinary checkout without relying on application
    mode metadata.
22. Without a global target policy, the effective target defaults to
    `defaultBranch` and supports a per-repo override.
23. Success is recorded only after exact validated-commit promotion.
24. Clean checked-out targets synchronize; dirty, inaccessible, or concurrently
    moved targets preserve `promotion_pending` state.
25. Historical missing promotions are audited and only explicit safe
    fast-forwards are applied.
26. A configured global target applies automatically to existing and new
    registrations without overriding explicit repository targets, switching a
    user checkout, or pushing a branch.
27. Shared/exclusive validation resources serialize only conflicting commands
    across concurrent sessions.
28. Transient validation failures use bounded retry, preserve exhausted state,
    and resume against the unchanged integration snapshot.

## Session task tracking

A session may have an ordered `tasks` array and `tasksUpdatedAt`. Each task has a
stable positive numeric ID, title, optional description, status, optional reason,
and `createdAt`/`updatedAt` timestamps. Missing tasks means an empty checklist;
legacy sessions require no migration. New tasks default to `pending`. Other
states are `in_progress`, `completed`, `blocked`, and `skipped`. At most one task
may be in progress. Blocked/skipped states require a non-empty reason. Agents
explicitly maintain the checklist through `tasks list/add/update/move`; no
background observer infers activity. Reordering never changes IDs and removal
is represented by skipping with a reason, preserving completed/skipped entries.

Task changes atomically update the session JSON under a short per-session record
lock. Lifecycle writes share the lock and retain the latest checklist rather
than overwriting it with a stale snapshot. The lock waits at most five seconds
and never reclaims unknown owners. Task state does not change integration status,
Git contents, validation evidence, promotion gates, or rollout requirements.

The dashboard shows current task and completed/total count in session rows. Its
selected pane keeps the title and status pinned, shows the next action first,
and places the full checklist after session details. It provides wrapping,
independent keyboard scrolling, and a separate footer labeling the visible line
range and remaining content above or below.
Tab changes pane focus; arrows, Page Up/Down, and Home/End navigate the focused
area. Narrow terminals open full details with Tab/Enter. Refresh and selection
changes preserve per-session detail offsets, clamped to the available content.

### No-change completion

`finish --no-changes --summary "..." [--session <id>] [--satisfied-by <id>]`
closes an active session as `no_changes` only when its source branch and commit
still match begin, its observable working-tree baseline is unchanged, no merge
or integration/recovery state exists, and every recorded task is completed or
skipped. Persist `closedAt`, `completionSummary`, and optional
`satisfiedBySessionId`. The referenced session must be successfully promoted in
the same repository and its exact source commit must be an ancestor of the
current source. Preserve its PR/rollout obligations without copying commit
promotion claims into the new session. Serialize final verification and storage
with task edits and reject stale lifecycle writes that would reopen it.

The dashboard treats `no_changes` as finished for filters and action gating.
Skipped progress is explicit; all-skipped tasks alone are not session completion.
No Git or source-file changes occur. Dependencies continue to require a
successfully integrated session. Guidance requires explicit no-change completion
before the agent's final response; finishing a terminal conversation is not a
session-state event.

## Coding harness support

`begin --harness codex|claude|gemini|grok` records the originating harness. Omitted
flags and legacy session records mean Codex. Installation and `doctor --harness`
select the native user skill and global instruction paths documented in README.
All harnesses share the Git lifecycle, nested resolution, and automated diagnosis.
`nested-agent` selects the session's harness; `nested-codex` is a compatibility
alias. Optional `harnessCommands` overrides executable paths. Shared response
validation and failure preservation apply to every adapter. Installation metadata
lives in `harnesses.json`; bulk refresh and `doctor --installed` cover every
installed workflow. Harness-specific differences must reflect documented CLI
behavior, not exclusive features. Current-session support requires no provider
credentials in seshx.
