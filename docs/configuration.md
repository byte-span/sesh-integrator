# Repository configuration

[Back to the README](../README.md)

Commands below run from the repository root unless stated otherwise.

- [`register`](#register)
- [Optional pull-request promotion](#optional-pull-request-promotion)
- [Stable default branch with a development target](#stable-default-branch-with-a-development-target)

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
    "reviewers": ["scram-j"],
    "assignees": ["scram-j"]
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
    "reviewers": ["scram-j"],
    "assignees": ["scram-j"]
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

`validationCache` defaults to `session`: successful commands are reusable only
for the same Git tree, command fingerprint, platform, architecture, and Node
version in that handoff. Set it to `repository` for content-addressed reuse
across sessions, or `off` to disable reuse. Auto-detected advisory JavaScript
setup is skipped only when its manifest/lockfile fingerprint matches and the
worktree still has its dependency marker. Explicit required setup is never
skipped.
