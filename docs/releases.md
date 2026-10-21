# Releases

After reviewed changes reach `main`, open **Actions → Release → Run workflow**,
select **main**, choose **patch**, **minor**, or **major**, and run it. That is the
only release initiation step. For example, from `0.1.0`, these produce `0.1.1`,
`0.2.0`, or `1.0.0`. Use patch for fixes, minor for features, and major for breaking
changes once the project reaches 1.0.

The workflow automatically:

1. Pins the selected `main` commit and calculates the next version from the
   highest stable `vX.Y.Z` tag or the development package version.
2. Creates a detached release commit changing only `package.json`'s version.
3. Checks formatting and types, builds, runs the full test suite (including
   installation of the packed CLI), and checks performance budgets on Linux / Node 22.
4. Builds an installable `sesh-integrator-X.Y.Z.tgz` and `SHA256SUMS`.
5. Pushes the new tag and publishes a GitHub Release with generated notes and
   both files. The workflow summary links to the release.

`main` and `dev` retain the development version; version bumps belong to release
tags. Each tagged commit is a child of the exact reviewed `main` revision, so
the archive and GitHub source downloads have the correct version without bot
pushes to protected branches or a version-sync PR. Existing tags are never moved.
Prerelease tags do not participate in version selection.

## Next release notes

Add these to the next release's GitHub Release notes (**Releases → Edit** on
that release), then keep them here under its version heading.

**Build queue changes for existing users:**

- **Default concurrency is now `auto`.** On a machine without a queue
  `config.json`, integrator-launched setup, validation and post-checks run up to a
  resource-aware number of commands at once instead of all at once. Explicit
  machine settings are unchanged. Run `seshx queue status` to see the effective
  values and whether each is a default or a machine setting.
  - To keep the previous unrestricted scheduling, run
    `seshx queue configure --concurrency unlimited`.
  - If you ran `seshx queue configure --wait-seconds` while `unlimited` was the
    default, your file already records `unlimited` and status shows
    `machine setting`. Run `seshx queue configure --concurrency auto` to adopt
    the new default.
- **Waits time out only without progress.** `--wait-seconds` (default 900) now
  limits time with no running command finishing and no movement up the queue,
  not total wait. A busy but moving queue no longer times out.
- **Orphaned entries fail fast.** If a running entry's owner process has exited,
  waiters fail at once with the entry ID and the exact
  `seshx queue recover <entry-id> --confirmed-stopped` command. Confirm its
  workload stopped before recovering.
- Coordinators pinned by unfinished sessions keep their old defaults until those
  sessions finish. Write `--concurrency auto` explicitly to limit them too.
- **Lightweight commands can skip the queue (opt-in).** Set
  `bypassBuildQueue: true` on a validation tier of quick checks, such as a
  `TASKS.json` validator and formatter check, and `setupBypassBuildQueue: true`
  on a repository whose setup is a quick warm-cache install. They then run at
  once instead of waiting behind test suites. Nothing changes until you set
  them; never set them for builds or tests.
  [Lightweight commands →](build-queue.md#lightweight-commands)

See [build queue defaults](build-queue.md#defaults).

## Install a release

Download the `.tgz` from the repository's **Releases** page, then run:

```bash
npm install -g --foreground-scripts ./sesh-integrator-X.Y.Z.tgz
seshx setup
```

Use the downloaded filename in place of `X.Y.Z`. The archive includes the built
CLI; consumers do not need pnpm or TypeScript. These are GitHub releases; this
workflow does not publish to the npm registry.

## Setup and recovery

The workflow becomes available once `.github/workflows/release.yml` is merged
into the default branch, `main`. It uses GitHub's built-in `GITHUB_TOKEN` with
`contents: write`; no personal token or npm secret is needed. Repository or
organization rules must allow that token to create `v*` tags and releases.
It runs only through manual dispatch on `main`, never from pull requests.

Publication is serialized and runs only after checks pass. A test failure
creates no remote tag or release. After a transient failure, use **Re-run all
jobs** on the same workflow run. If its tag was already pushed, the workflow
reuses that exact commit/version, finishes uploading assets to its draft, then
publishes. An already-published release is left unchanged. Starting a new run
requests a new version. Do not move/delete an existing release tag to retry.
If a newer release tag already exists, start a new run from current `main`
instead of resuming an older run.

The first real publication must be initiated by a maintainer after reviewing
and merging this automation. Local validation does not exercise GitHub's write
permissions or publish a release.
