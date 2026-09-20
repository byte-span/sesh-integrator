# Execution readiness and manual handoff

Run `seshx capabilities --recheck` in the **same execution context** that will
run the lifecycle commands. Doctor runs the same disposable probes without
persisting reports or changing choices. Setup and consequential lifecycle
commands check readiness before their work; installation compatibility checks
alone do not establish runtime permissions.

The checks exercise exclusive file creation, file rename/unlink, directory
creation/rename/removal, and recursive cleanup at existing runtime parents,
coordinator storage, source/recovery worktree storage, the current checkout,
and common/worktree Git metadata directories. Setup additionally checks the
parents of its planned guidance and skill writes. Missing directories are tested
at their nearest existing parent. A separate disposable Git repository tests
index and ref writes, commit creation, and worktree add/remove. It uses isolated
Git configuration, no hooks, and an unsigned synthetic identity. **Real source
and integration commits retain their signing and hook policy.** Probes do not
read `.env` files or change existing refs, indexes, worktrees, locks, or sessions.

These are samples, not permission guarantees. A path-specific rule can deny a
later operation even after a pass. Repository hooks, signing, validation tools,
network access, loopback listeners and remote permissions retain their own
checks. Git's ownership protections are not disabled for the real repository.

## Evidence and choices

A failure identifies the operation, location and available evidence. EPERM and
EACCES establish denial, not its cause: Unix modes, ACLs, sandbox policy and
other host restrictions can produce them. EROFS identifies a read-only
filesystem response; missing paths/executables and Git ownership errors are
reported separately. macOS Terminal succeeding where an agent fails is useful
context, not proof that recursive `.env` rules caused the denial.

Choose one durable response:

1. **Repair the environment after review.** Inspect the reported path's owner,
   ACL and mount policy, then compare the same probe in the agent and authorized
   shell. Ask the administrator for a proposed change limited to the proven
   path and operation, with its exact configuration diff and rollback. Preserve
   secret deny rules. If a scoped writable runtime is appropriate, configure
   `SESH_INTEGRATOR_HOME` for future work; do not move an existing runtime or
   its sessions to bypass a failure. Keep the original runtime for recovery.
   Run `seshx capabilities --recheck` after the approved repair. No repair script
   is generated from an ambiguous denial: a blanket chmod, sandbox relaxation,
   Git safe-directory wildcard or `.env` exclusion removal is not a diagnosis.
2. **Persist restricted/manual handoff:** `seshx capabilities --mode manual`.
   This stops automatic setup and begin/commit/validate/integrate/resume/finish
   and reconcile-apply operations in that repository and execution context.
   It does not invent a new success state or perform partial integration.
   Inspection and task notes remain available. No confirmation loop or repeated
   terminal workaround is used. `--recheck` reports capabilities but does not
   change this choice. Restore automation explicitly with
   `seshx capabilities --mode automatic`, then `seshx capabilities --recheck`.
3. **Opt out of this repository:** `seshx disable`. Existing repository
   disablement remains independent; registration, probes and recovery choices
   never enable it. This command also needs permission to write runtime state.

Choices and blocked reports are stored in the runtime's `capabilities/`
directory, keyed by canonical repository common directory and execution-context
hash. Linked worktrees share the choice. The hash includes host, OS, architecture,
user ID where available, Node executable, PATH, and selected sandbox indicators;
no environment dump or credentials are recorded. If two wrappers expose identical
signals despite different policies, give each a stable, non-secret
`SESH_EXECUTION_CONTEXT` label. Changing relevant signals establishes a new
context and triggers fresh readiness checking without carrying a shell's pass
into the agent. Successful checks are rerun before consequential operations;
failed checks stop without repeating probes until an explicit recheck. Context
labels are diagnostics, not security boundaries or permission grants.

If runtime writes are denied, the CLI reports that the choice/evidence could not
be saved. It cannot promise persistence without storage access; use an authorized
context against the same runtime to save the intended choice. Never overwrite a
pinned coordinator or remove an unknown lock to make this work.

## Partial operations and existing sessions

Failed probe cleanup lists the exact owned artifacts. Inspect those paths before
manual removal; do not generalize them into recursive cleanup of the runtime.
Later rechecks retain outstanding artifact paths until they are absent. Snapshot
retention preserves the original copy/rename error alongside cleanup errors and
names the temporary `.install-*` directory. A late failure may follow partial
progress: consult `seshx status --session <id>` and the original error before
retrying. The CLI retains permission-failure evidence; it does not erase session
or recovery data and does not pretend the failed command never mutated state.

For an existing session, keep its ID, recorded source checkout, pinned coordinator,
recovery bundle and Git refs. In an authorized execution context with access to
the same runtime, recheck capabilities and run the original lifecycle command
from that source checkout. Use `resume --session <id>` for resumable integration
states; active source work still uses commit/validate/integrate. A legacy pinned
coordinator may not implement `capabilities`; run the check using a compatible
new installation against the same runtime, but keep lifecycle recovery on the
recorded coordinator. Do not replace it in place. Inspect successful source
promotion separately from installation, PR review/merge, and external rollout.

The application can improve readiness and recovery handling. It cannot resolve
host restrictions through its own configuration.
