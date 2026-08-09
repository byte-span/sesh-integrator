# Staging and Target Promotion Audit

This audit records the repository-wide classification performed before adding
final target promotion.

## 1. Valid internal staging behavior

- `DEFAULT_INTEGRATION_BRANCH` and existing `integrationBranch` configuration
  remain the internal staging branch and keep backward-compatible meaning.
- The dedicated integration worktree, exact `readyCommit` merge, conflict
  prompt, staged-tree retry verification, setup, integration validation,
  signing preflight, and staging commit remain isolated from user worktrees.
- The per-repository lock continues to serialize staging and promotion.

## 2. Configurable defaults

- `targetBranch` is optional. Its effective value is the registered
  `defaultBranch`; a repository can explicitly override it.
- A missing staging branch is created from the current target rather than from
  an assumed branch name.
- Existing configurations without `targetBranch` need no rewrite.
- An explicit target equal to staging is retained as a legacy-style opt-in;
  normal registrations keep the refs separate.

## 3. Incorrect final-destination assumptions corrected

- A staging commit no longer marks a session `succeeded`.
- Post-integration checks now precede final target promotion.
- CLI, status, doctor, workflow, README, specification, tasks, migration guide,
  examples, and project instructions distinguish staged/validated from
  promoted/succeeded.
- The former prohibition on updating `main` or `master` was replaced by a
  generic configured-target safety policy.

## 4. Safety rules refined for promotion

- The target's expected commit is captured after acquiring the repository lock.
- An unheld target uses atomic `git update-ref <ref> <new> <expected-old>`.
- A held target is advanced only from its one accessible, clean worktree at the
  expected commit, using a verified fast-forward so ref, index, and files stay
  synchronized.
- Dirty, inaccessible, multiply held, divergent, or concurrently moved targets
  preserve the validated staging commit as `promotion_pending`.
- Staging-behind-target state is fast-forwarded before a new merge. Staging-ahead
  and divergent state require explicit reconciliation.

## 5. Documentation and test migration

- Historical `succeeded` records absent from the target are audited by
  `reconcile`. `--apply` is allowed only for a recorded exact staging head and
  ancestry-safe fast-forward.
- Disposable tests cover default and overridden targets, held and unheld
  targets, clean/dirty/inaccessible target worktrees, concurrent movement,
  divergence, signing/validation/post-check ordering, conflict and clean retry,
  source advancement, exact commit promotion, locking, backward-compatible
  configuration, reconciliation, and absence of push behavior.

## Earlier-fix compatibility review

- Exact ready commits remain immutable integration inputs and exact validated
  staging commits are immutable promotion inputs.
- Resume still accepts a source branch that advanced while retrying only the
  recorded ready commit.
- Observable inaccessible-path handling remains scoped to source and staging
  worktrees; inaccessible target worktrees block promotion without mutation.
- GPG programs remain command-scoped, and signing failures occur before staging
  commit creation or promotion.
- Conflict and clean-merge retries preserve their staged trees. Post-check and
  promotion retries have explicit recovery phases.
- Lock ownership and stale staging-worktree recovery are unchanged; target
  promotion happens while the same repository lock is held.
- Validation and post-integration failures cannot advance the target.

No repository name, path, branch, command, session ID, or commit is hard-coded.
No migration path fetches, pushes, force-updates, resets, deletes, or merges
divergent history.
