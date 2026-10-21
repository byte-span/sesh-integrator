# Repository configuration

[Back to the README](../README.md)

Commands below run from the repository root unless stated otherwise.

- [`register`](#register)
- [Integration batching](#integration-batching)
- [Optional pull-request promotion](#optional-pull-request-promotion)
- [Stable default branch with a development target](#stable-default-branch-with-a-development-target)
- [Reusing source validation when the target moves](#reusing-source-validation-when-the-target-moves)
- [Central delivery policy](#central-delivery-policy)

### `register`

Run once for each repository:

```bash
cd ~/Developer/my-project
seshx register
```

Registration records the real Git common directory, branches, and central
setup/validation commands. Re-registering updates requested empty command lists
rather than adding a duplicate.

Pass `--auto-config` to detect setup commands plus safe root `package.json`
validation scripts. It works during initial registration and for an existing
registration:

```bash
seshx register --auto-config
```

Setup detection prefers an executable `scripts/bootstrap`, `scripts/setup`, or `bin/setup`.
Otherwise it recognizes pnpm, Yarn, npm, Bun, uv, Poetry, Cargo, Go modules,
Bundler, Composer, and Mix lockfiles. For JavaScript projects it also detects
`format:check`, `typecheck`, `lint`, and `test` for source validation, then adds
`build` for integration validation. It ignores scripts such as end-to-end
tests, deployment, and release commands. Existing non-empty command lists are
never replaced.

Repositories can opt into explicit aggregate scripts. `handoff:source` and
`handoff:integration` override the detected validation lists, while
`handoff:post-integration` is the only package script automatically selected
for post-integration work:

```json
{
  "scripts": {
    "handoff:source": "pnpm format:check && pnpm typecheck && pnpm test",
    "handoff:integration": "pnpm handoff:source && pnpm build",
    "handoff:post-integration": "node scripts/notify-integration.mjs"
  }
}
```

Auto-configuration never executes the detected scripts. It only writes their
argument arrays to `~/.sesh-integrator/config.json`. If no supported scripts are
found, registration still succeeds and reports that the command lists remain
unconfigured.

For an unknown ecosystem, provide one or more argument arrays once during
registration:

```bash
seshx register --setup-command '["make","bootstrap"]'
```

Edit `~/.sesh-integrator/config.json` to add validation and conflict settings. Commands are argument arrays and are never passed through a shell:

```json
{
  "lockWaitSeconds": 900,
  "codexCommand": "codex",
  "conflictResolutionMode": "current-session",
  "defaultPromotion": {
    "reviewers": ["example-user"],
    "assignees": ["example-user"]
  },
  "repositories": [
    {
      "path": "/Users/you/Developer/my-project",
      "gitCommonDir": "/Users/you/Developer/my-project/.git",
      "defaultBranch": "main",
      "integrationBranch": "sesh-integrator/integration",
      "targetBranch": "main",
      "promotion": { "type": "none" },
      "gpgProgram": "/Users/you/.local/bin/codex-gpg",
      "setupCommands": [["corepack", "pnpm", "install", "--frozen-lockfile"]],
      "setupCommandPolicy": "advisory",
      "validationCache": "session",
      "sourceValidationCommands": [
        {
          "parallel": [
            ["pnpm", "typecheck"],
            ["pnpm", "test"]
          ]
        }
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
      "conflictInstructions": "Preserve compatible intent and follow repository AGENTS.md."
    }
  ]
}
```

`integrationBranch` is internal staging. `targetBranch` is the final local
destination and may be omitted; omission is backward compatible and resolves
to the registered `defaultBranch`. Existing `integrationBranch` values keep
their staging meaning. An explicit `targetBranch` equal to `integrationBranch`
is supported as a legacy-style opt-in, but then there is no separate final ref
and that branch cannot already be checked out in another worktree. No branch is
pushed unless pull-request promotion is explicitly configured.

### Integration batching

Integration validation runs while the repository lock is held, so sessions
that finish together used to be validated one after another. With batching,
the next lock holder (the batch leader) merges every waiting session into one
candidate, validates it once and promotes it. Batching is on by default:

```json
{
  "integrationBatching": { "enabled": true, "maxSessions": 8 },
  "repositories": [
    {
      "path": "/Users/you/Developer/my-project",
      "integrationBatching": { "enabled": false }
    }
  ]
}
```

| Key           | Meaning                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `enabled`     | `false` integrates one session at a time. Default `true`.                    |
| `maxSessions` | Sessions in one candidate, including the leader: an integer 1-64. Default 8. |

The global `integrationBatching` sets defaults; a repository's
`integrationBatching` overrides them key by key. Invalid values or unknown
keys stop every command with a configuration error. `maxSessions: 1` also
turns batching off.

**Who joins.** A session joins only while its own `integrate` process waits
for the lock on this machine and its dependencies have succeeded. It must
target the same branch with the same promotion settings as the leader, and
have no earlier integration attempt (recovery bundle, preserved merge or
staged commit). The oldest ready sessions join first, up to the cap; the rest
wait for the next lock holder.

**What happens.** Under the lock, the leader:

1. Merges each member's exact `readyCommit` in ready-time order (then session
   ID) with Git plumbing. Each merge is an ordinary
   `Integrate <session>: <task>` merge commit on top of the target.
2. Leaves out a member whose merge conflicts. That session integrates alone
   after the batch and gets the normal conflict prompt and `resume` flow.
3. Validates the combined commit once in a detached batch worktree
   (`worktrees/<repo-id>-batch`). It runs setup, then the strictest selection
   any member needs: a shared validation tier when every member selected the
   same tier and the combined paths still match it, otherwise the full
   integration commands.
4. Advances staging with an expected-old check, then promotes the target with
   the usual expected-previous-target check, post-integration commands and
   pull-request promotion.

Every member records the shared staging and promoted commit, keeps its own
completion summary, rollout classification and follow-ups, and gets its own
recovery bundle. A waiting `integrate` names the batch it joined and does not
time out while the leader works on it. When the batch resolves the session,
the process exits with that session's completion summary instead of
integrating again.

**When combined validation fails**, no member is promoted on that tree. The
leader splits the members into halves and validates each half on its own,
recursively. A single remaining session is integrated alone through the
normal path, so passing sessions still promote and only a session that fails
alone becomes `validation_pending`, with the usual preserved state for
`resume`. A half whose combined tree already failed in this batch is split
again without rerunning it.

**When promotion is blocked** (for example a dirty checked-out target), every
member of the validated candidate becomes `promotion_pending` with the same
staged commit, and the leader stops batching. Run `seshx resume` for each
member as usual; the first promotes the commit and the rest find it promoted.

**Older coordinators** neither lead nor join batches, ignore the
`integrationBatching` keys, and keep integrating one session at a time.
Sessions that older coordinators run never advertise themselves to a batch
leader. Member records use the same fields and recovery bundles as a single
integration, so the session state contract does not change.

If a batch leader stops while holding the lock, the lock stays in place for
manual inspection as before. After it is cleared, members rerun
`seshx integrate`; a claim left without a result is released under the lock.

#### Batches and validation reuse

A combined batch tree never equals any member's source-validated tree. Batch
validation therefore runs every selected command, without session,
repository-cache or source-result reuse. The
[`reuseSourceValidationOnTargetMove`](#reusing-source-validation-when-the-target-moves)
opt-in does not apply to a batch candidate either: every other member's
changes count as target movement, so the strictest selection runs in full.
Sessions integrated alone (a conflicting member, a member isolated after a
failed combined validation, or a leader with no waiting sessions) follow the
normal single-session rules, including that opt-in.

### Optional pull-request promotion

Remote promotion is disabled by default. To turn a successful local `dev`
handoff into a review-ready `dev` to `main` PR, configure:

```json
{
  "targetBranch": "dev",
  "promotion": {
    "type": "pull-request",
    "productionBranch": "main",
    "remote": "origin",
    "reviewers": ["platform-team"],
    "assignees": ["release-owner"]
  }
}
```

After local promotion and post-integration checks pass, `sesh-integrator` performs
a normal non-force push, reuses an existing open PR for the same branch pair or
creates a ready-for-review PR, requests configured reviewers, and adds configured
assignees. Omit
`productionBranch` to use `defaultBranch`, omit `remote` to use `origin`, and
omit `reviewers` when CODEOWNERS or another GitHub policy assigns reviewers.
The remote step requires authenticated `git` and `gh` access. Failures remain
resumable with `seshx resume`.

In shared-target mode, a non-fast-forward push caused by an advanced remote
target is recovered automatically. The tool fetches the exact remote target,
merges it into the validated staging integration, runs full integration
validation and post-integration checks again, promotes the rebuilt commit
locally, and retries the normal push. Recovery is limited to three attempts.
Conflicts are preserved for `seshx resume`; validation failures,
ambiguous ancestry, and continued remote movement stop safely. The fetched
commit and attempt count are persisted so interrupted recovery is resumable.

The shared target is fetched while holding the repository integration lock,
immediately before the integration baseline is recorded. A normal remote
fast-forward is incorporated into that baseline. If the remote moves again,
the exact combined result is rebuilt and fully revalidated before each bounded
non-force push retry. A remote tip that is not descended from the locked
baseline is treated as replaced history and stops with a diagnostic; the tool
never force-pushes through it.

Protect shared target branches on the hosting provider: prohibit force pushes
and branch deletion, and require updates to remain fast-forward-compatible.
These settings are part of the reliability contract for automatic shared-target
promotion; rewritten history always requires manual inspection.

This is the backward-compatible shared-target mode. Its explicit spelling is
`"mode": "shared-target"`; omitting `mode` behaves identically.

For an independent PR for every completed session, configure
`"mode": "session-branch"`. That mode pushes the exact recorded source commit
to the session's source branch and opens a PR from it to the production branch.
Multiple session PRs may remain open concurrently. A retry reuses only an open
PR whose head and embedded session marker belong to that same session, and
never edits another session's PR.

```json
{
  "targetBranch": "dev",
  "promotion": {
    "type": "pull-request",
    "mode": "session-branch",
    "productionBranch": "main",
    "remote": "origin",
    "reviewers": ["platform-team"],
    "assignees": ["release-owner"]
  }
}
```

Both modes use normal non-force pushes and never merge, close, delete, or
force-update remote branches or PRs. Before pushing, the tool validates branch
names, the configured remote, `gh` authentication, remote base existence, and
that base and head commits differ. `status` reports the mode and saved PR URL;
`doctor` checks remote-promotion readiness.

To apply participants to every repository that already uses pull-request
promotion, set global defaults once:

```json
{
  "defaultPromotion": {
    "reviewers": ["example-user"],
    "assignees": ["example-user"]
  }
}
```

Per-repository `reviewers` and `assignees` override their corresponding global
lists. Set either repository list to `[]` to disable that default for one
repository. These defaults do not enable remote promotion by themselves.

### Stable default branch with a development target

Some repositories keep `main` as the default and stable branch while agents
work on `dev`. For that workflow, keep the detected `defaultBranch` unchanged
and set an explicit target in `~/.sesh-integrator/config.json`:

```json
{
  "defaultBranch": "main",
  "integrationBranch": "sesh-integrator/integration",
  "targetBranch": "dev"
}
```

This makes successful handoffs promote locally to `dev`; it does not merge or
push `main`. A separate trusted review workflow can then promote `dev` to
`main`. Apply the same setting to repositories registered before adopting this
branch policy: when `targetBranch` is omitted, the global `defaultTargetBranch`
applies; only when both are absent does it resolve to `defaultBranch` (`main`
in this example).

An explicit per-repository target must already exist locally. For example,
track an existing remote branch or create it from `main` before beginning a
handoff:

```bash
git switch --track origin/dev 2>/dev/null || git switch -c dev main
```

#### Automatic global policy

Set the global `defaultTargetBranch` to make the same policy automatic for both
existing and newly registered repositories. With
`"defaultTargetBranch": "dev"`, target resolution will use this precedence:

1. an explicit repository `targetBranch` override
2. the global `defaultTargetBranch`
3. the repository `defaultBranch`

Changing the global default will immediately affect existing registrations
that omit `targetBranch`; it will not overwrite explicit repository overrides.
Registration and pre-session checks reuse a local `dev`, track
`origin/dev` when available, or create local `dev` from the registered default
branch. They must not switch the user's checkout or create a target from an
unborn default branch. No target branch is pushed automatically.

An older entry that omits `targetBranch` while setting `integrationBranch`
equal to `defaultBranch` or the effective global target is rejected as
ambiguous instead of being silently migrated. Review its history, then
configure a separate staging branch or make the combined target choice
explicit.

`gpgProgram` is optional. When set, `sesh-integrator` applies it only to its
controlled source and integration commit commands. When signing is enabled,
the CLI performs a real in-memory OpenPGP signing preflight immediately before
each commit and refuses to invoke Git if the agent, key, pinentry, or program is
unavailable. Direct-integration merge commits are signed when the effective
`commit.gpgSign` setting is enabled.

Auto-configured setup is `advisory` during `begin`: failure prints a warning but
does not block branch or session creation. Explicit `--setup-command` setup is
`required` and still blocks `begin` on failure. Integration normally requires
successful setup before its selected validation commands. The workflow skill
commits the focused change, then runs `seshx validate` against that exact
commit. After the staging branch advances, the CLI promotes the validated
commit and runs `postIntegrationCommands` from the clean worktree checking out
the target branch. Configuring these commands therefore requires exactly one
accessible, clean target checkout. All commands are argument arrays executed
directly without a shell.

Before any non-empty validation plan, `sesh-integrator` infers safe disposable
framework preparation directly from package manifests, including packages
nested in a monorepo. It currently recognizes Next.js type generation,
SvelteKit sync, Nuxt prepare, Astro sync, and React Router type generation. It
skips preparation already present in a package script and does not infer
deployment, migration, release, or source-rewriting generators. These defaults
apply to existing registrations without additional configuration.

The general validation-scope policy is maintained in the
[bundled workflow reference](../skill/sesh-integrator-workflow/SKILL.md#validation-scope)
and distributed with the installed skill and managed global guidance. Keep
project-specific path lists and meaningful check commands in each registration;
do not duplicate the general workflow in repository instructions. No global
one-size-fits-all path allowlist is imposed on existing registrations.

Validation tiers are evaluated in configuration order. A tier matches only when
every changed path matches at least one of its glob patterns; otherwise the
legacy source/integration lists form the `full` tier. `--auto-config` adds a
documentation-only tier. Re-run registration with `--auto-config` to add it to
an existing repository with no tiers configured.

An explicitly configured tier may set `bypassIntegrationWorktree` to `true`.
The bypass is used only for the exact commit previously checked by
`seshx validate`, and only when the tier has no integration commands and
the repository has no post-integration commands. Under the repository lock, the
CLI uses Git plumbing and atomically advances the staging ref, then promotes
through the normal checked-target safety path. Conflicts or
unsupported Git fall back to the normal integration worktree. A clean,
tool-owned integration worktree may be removed before this update; user
worktrees are never removed.

Validation command lists also accept explicit `{ "parallel": [...] }` groups.
Commands within a group run concurrently; groups and ordinary commands still
run in order and any failed member stops validation. Auto-configuration groups
independent inferred checks and adds documentation-only and test-only tiers.

Commands that share finite infrastructure can declare opaque resource keys and
failure behavior without naming a framework or service in sesh-integrator:

```json
{
  "command": ["tool", "check"],
  "resources": {
    "shared": ["environment:read"],
    "exclusive": ["fixture:mutable"]
  },
  "failure": {
    "classification": "transient",
    "maxAttempts": 3,
    "initialBackoffMs": 250,
    "maxBackoffMs": 2000
  }
}
```

Shared holders may overlap; exclusive holders serialize with both shared and
exclusive holders for the same key, including validations in other repositories
and sessions. Multiple keys are acquired in sorted order. Unrelated keys remain
concurrent. Commands default to an unclassified, resumable failure after one
attempt. A non-zero exit is evidence, not a deterministic verdict. A command
declared transient uses bounded exponential backoff; omitted retry values
default to three attempts, 250 ms initial backoff, and a 2 s cap. Legacy
`deterministic` declarations are accepted but treated as unclassified.

A failed command's record keeps a bounded, redacted tail of its stdout and
stderr, the path of a full redacted log under `<runtime>/logs/validation/`, the
failing test names or first error line, and the build queue load at failure
time. See [failure evidence](build-queue.md#failure-evidence).

`validationCache` defaults to `session`: successful commands are reusable only
for the same Git tree, command fingerprint, platform, architecture, and Node
version and execution environment in that handoff. Set it to `repository` for content-addressed reuse
across sessions and coalesce identical concurrent validation plans, or `off` to
disable reuse. Repository caching requires worktree-independent checks without
required local artifacts or external mutable inputs; see [reuse boundaries](build-queue.md#validation-and-caching). Auto-detected advisory JavaScript
setup is skipped only when its manifest/lockfile fingerprint matches and the
worktree still has its dependency marker. Explicit required setup is never
skipped.

### Reusing source validation when the target moves

Integration reuses `seshx validate` results only for the exact tree they
checked. If other work moved the target first, the merged tree differs and
every selected integration command runs again, even when the target moved only
by a `TASKS.json` update. A tier can opt in to keep the source results in that
case:

```json
{
  "name": "task-register",
  "paths": ["TASKS.json"],
  "sourceValidationCommands": [["qtask", "validate", "."]],
  "integrationValidationCommands": [
    ["qtask", "validate", "."],
    ["pnpm", "exec", "prettier", "--check", "TASKS.json"]
  ],
  "reuseSourceValidationOnTargetMove": true
}
```

**What the opt-in asserts.** `reuseSourceValidationOnTargetMove: true` states
that changes confined to this tier's paths cannot change the result of any
other validation command, beyond what this tier's own integration commands
check on the merged tree. Opt in only when that holds, for example a task
register that no test, build or lint step reads, with its format checked by
the tier itself. Do not opt in a tier whose paths tests, builds, generators,
packaging or formatters read without the tier checking them, such as
documentation that tests or a repository-wide format check cover, packaged
guidance, or configuration. A tier without integration commands asserts that
its paths need no check at all.

**When it applies.** Integration lists every path that differs between the
session's validated source tree and the merged tree, listing both sides of a
rename. Source results are reused only when all of these hold:

1. The exact ready commit passed `seshx validate`.
2. `validationCache` is not `off`.
3. The session is not in local target recovery (`recoveryPhase` `local_target`).
4. The first tier in configuration order whose patterns match every differing
   path (the rule that selects a session's tier) sets the option to `true`.

Integration then runs that tier's integration commands on the merged tree,
reuses the session's source results for its other selected integration
commands, and runs every command without a source result, such as an
integration-only `build`, on the merged tree. A differing path outside that
tier, a mixed movement, or a matching tier without the opt-in keeps the full
rerun. Reused results are never recorded as results for the merged tree.

**What you see.** `integrate` prints `Source validation reuse:` with the tier
and differing paths, then `Reusing source validation: <command> (target moved
only by <tier> paths)` for each reused command. Otherwise it prints `Source
validation reuse skipped:` and the reason. The session's performance record
under `<runtime>/performance/` stores `integrationSourceReuse` (`exact-tree`,
`applied` or `skipped`), `integrationSourceReuseReason`,
`integrationSourceReuseTier`, `integrationSourceReuseDifferingPaths`,
`integrationSourceReusedCommands` and `integrationSourceReusedCommandList`.

Any value other than `true` or `false` stops every command with a
configuration error. Older coordinators ignore the key and rerun the full
plan. [Integration batches](#batches-and-validation-reuse) never use it.

## Central delivery policy

A delivery policy decides, for many repositories at once, which branch a
session targets, how it is promoted, and when its work counts as landed. It is
meant for automation (for example, workers that run every task through
`seshx`) that should not depend on each machine's per-repository settings.
This section is the canonical description of the policy format.

### Choosing the policy

`seshx begin` uses the first of:

1. `--policy-file <path>` (relative to the current directory)
2. the global `deliveryPolicyFile` in the runtime's `config.json` (a relative
   path is resolved against the runtime directory)
3. no policy: today's repository configuration applies and `delivery` is `null`

When a policy is selected, `begin` fails before changing anything if the file
is missing or unreadable (`policy_missing`) or invalid (`policy_invalid`).
[Error documents →](commands.md#machine-readable-output)

Check a file without starting a session:

```bash
seshx policy check --file delivery-policy.json
seshx policy check --file delivery-policy.json --repository byte-span/sesh-integrator
```

The first prints the validated policy with defaults filled in; the second
prints the rule `begin` would record for that repository.

### Format `sesh-integrator/delivery-policy@1`

```json
{
  "schema": "sesh-integrator/delivery-policy@1",
  "version": "optional, for example the deploy commit",
  "defaults": {
    "targetBranch": "dev",
    "promotion": {
      "type": "pull-request",
      "mode": "shared-target",
      "productionBranch": "main",
      "remote": "origin",
      "reviewers": ["example-user"],
      "assignees": ["example-user"]
    },
    "completion": "production-merged"
  },
  "repositories": {
    "byte-span/secret-sync": {
      "promotion": { "type": "none" },
      "completion": "local"
    }
  }
}
```

| Field                        | Rule                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `schema`                     | Exactly `sesh-integrator/delivery-policy@1`.                                                |
| `version`                    | Optional string, 1–128 characters. Recorded on sessions; `null` when omitted.               |
| `defaults`                   | Required. Must set `targetBranch`, `promotion` and `completion`.                            |
| `repositories`               | Optional. Keys are lowercase GitHub `owner/name`; values set any of the three fields.       |
| `targetBranch`               | Branch name (letters, digits, `.`, `_`, `-`, `/`; no `..`, `//`, `@{` or `.lock` parts).    |
| `promotion`                  | `{ "type": "none" }` or `{ "type": "pull-request", ... }`, as below.                        |
| `promotion.mode`             | `shared-target` (default) or `session-branch`.                                              |
| `promotion.productionBranch` | Pull-request base. Default `main`.                                                          |
| `promotion.remote`           | Git remote name. Default `origin`.                                                          |
| `promotion.reviewers`        | Optional, at most 15 GitHub logins or `org/team` names. Omitted: global `defaultPromotion`. |
| `promotion.assignees`        | Optional, at most 10 GitHub logins. Omitted: global `defaultPromotion`.                     |
| `completion`                 | `local`, `target-pushed` or `production-merged` (below).                                    |

- A repository entry replaces whole top-level fields of `defaults`.
  `promotion` is never deep-merged: an entry that sets `promotion` replaces all
  of it.
- Unknown fields anywhere are errors.
- Every resolved rule (`defaults`, and each entry applied over `defaults`) must
  be consistent, or the whole file is invalid:
  - `promotion.type: none` requires `completion: local`;
  - `mode: session-branch` never pushes the target, so it allows only `local`
    or `production-merged`;
  - `productionBranch` must differ from `targetBranch`.
- The policy holds no secrets; never put credentials in it.

`completion` says when work counts as landed. sesh-integrator records it; the
consumer that reports completion evaluates it against the session's
`readyCommit`, the exact task commit sesh-integrator merges:

| Value               | Landed when `readyCommit` is an ancestor of             |
| ------------------- | ------------------------------------------------------- |
| `local`             | local `<targetBranch>` (true once the session succeeds) |
| `target-pushed`     | `<remote>/<targetBranch>` after a fetch                 |
| `production-merged` | `<remote>/<productionBranch>` after a fetch             |

Ancestry only holds when pull requests from the target are merged with merge
commits; squash merges are not supported by `production-merged`.

### Repository identity

`begin` identifies the repository from the configured fetch URL
(`remote.<name>.url`, before any `insteadOf` rewriting) of the remote named by
`defaults.promotion.remote`, or `origin` when the default promotion is `none`
or that remote is not configured. Accepted forms, lowercased:
`https://github.com/O/N(.git)`, `git@github.com:O/N(.git)` and
`ssh://git@github.com/O/N(.git)`. A repository without an entry uses
`defaults`. If the URL is not a GitHub URL, or no such remote exists, `begin`
fails with `repository_unidentified`.

### What a session records and uses

`begin` records the resolved rule on the session as `delivery`:

```json
{
  "version": "policy version or null",
  "sha256": "<SHA-256 hex of the policy file bytes read>",
  "repository": "owner/name",
  "targetBranch": "dev",
  "promotion": {
    "type": "pull-request",
    "mode": "shared-target",
    "productionBranch": "main",
    "remote": "origin"
  },
  "completion": "production-merged",
  "source": "defaults"
}
```

`promotion` is stored normalized (defaults filled in); `source` is `repository`
when an entry matched. The session's `targetBranch` is set at `begin`.

- `begin` creates the worktree from the policy's `targetBranch`. A missing
  local target is created like a global default target: it tracks
  `<remote>/<targetBranch>` when fetched, otherwise starts at the registered
  default branch. `--sync-target` can fast-forward it first
  ([outcomes](commands.md#begin)).
- `integrate`, `resume` and the other source lifecycle commands use the
  recorded `targetBranch` and `promotion` instead of the repository's. Omitted
  `reviewers` and `assignees` fall back to the global `defaultPromotion`.
- Policy changes affect new sessions only.
- The staging integration branch is shared by all sessions of a repository, so
  keep a repository's policy target consistent with its other sessions. A
  policy target equal to the repository's `integrationBranch` fails `begin`
  with `policy_conflict`.
- Sessions with a delivery rule record coordinator state contract 2. Older
  coordinators, which would ignore the rule, refuse them; current builds
  accept contracts 1 and 2.

## Machine-local build capacity

Use `seshx queue configure --concurrency <unlimited|auto|1-64>` to limit commands across
repositories and sessions. Machines without an explicit setting default to `auto`,
a resource-aware limit; `seshx queue configure --concurrency unlimited` restores
the earlier unrestricted default. `--wait-seconds` (default 900) limits how long a
command waits without queue progress, not its total wait. Existing explicit
settings are retained, and `seshx queue status` shows the effective values.
Queue configuration is machine-local and independent of this repository
configuration. See [build queue defaults, recovery, and limits](build-queue.md#defaults).
Directly launched builds remain outside the queue.

The queue limits how many commands run, not how many workers each command
starts. This repository's Vitest config divides the available CPUs by the
effective queue concurrency to bound `maxWorkers` (7 per run with concurrency
`2` on 16 threads). Override it with `SESH_VITEST_MAX_WORKERS=<1-1024>`; see
[test workers](build-queue.md#test-workers). Configure equivalent limits in
other repositories' test runners.
