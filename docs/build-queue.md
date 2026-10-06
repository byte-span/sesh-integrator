# Shared build and test queue

Integrator-launched setup, inferred preparation, source validation, integration
validation, and post-integration commands share one local queue per user account
and host. Parallel validation groups still run all their checks, subject to the
shared capacity. Commands with named resources acquire those resources before
joining the queue. Git operations and agent work do not consume a slot.

**Builds and tests launched directly**, such as `pnpm build`, `npm test`, an IDE
task, or an older pinned coordinator, **remain outside the queue**. The queue
does not cap a command's internal workers or coordinate other OS accounts, VMs,
containers, or native Windows with WSL. Configure tool-specific worker limits
when a single command is itself too large. This repository leaves Vitest worker selection at its normal default.

## Inspect and configure

```sh
seshx queue status
seshx queue configure --concurrency unlimited
seshx queue configure --concurrency 2
seshx queue configure --wait-seconds 1800
seshx queue configure --concurrency auto
```

`seshx status` also prints the queue. Running and waiting messages identify the
session, queue position and capacity; queue status includes worktree and owner
PID. Setup and post-checks without a session argument identify their owning CLI
process and worktree. No command arguments or environment values are saved.

The default is `unlimited`, restoring unrestricted parallel scheduling. Status,
cancellation and orphan protection remain active. Existing explicit machine
settings are preserved. Opt into `auto` for the smallest of four commands, half the available CPU threads,
and one command per 4 GiB of memory after reserving 2 GiB, with a minimum of one.
Memory uses the lower of OS total memory and Node's process constraint when
available. This is a conservative estimate, not a guarantee against exhausting
memory. It uses stable capacity rather than changing free-memory samples.

The machine-local `config.json` lives in the path printed by `queue status`:
`~/.sesh-integrator/build-queue/<hostname-hash>/`. Windows resolves `~` using the
current user's home. These settings are independent of repository and runtime
configuration, so different repositories and custom integrator runtime homes
share the same capacity. Do not commit or sync this directory between hosts.

`concurrency` accepts `unlimited`, `auto` or 1–64. `waitSeconds` accepts 1–86400 (default 900).
Older pinned coordinators retain their original defaults and do not coalesce
validation plans. Coordinators predating `unlimited` cannot read that explicit
setting; finish their sessions before writing it to a shared configuration.
Changing capacity affects new admissions without interrupting existing work.
Wait-time changes apply to newly queued requests. Invalid settings stop admission
rather than disabling the queue.

For isolated tests or an alternative **local** location, set
`SESH_BUILD_QUEUE_HOME` consistently for every participating process. A different
path is a separate queue. Do not use a network share. POSIX shells use
`export SESH_BUILD_QUEUE_HOME=/local/path`; PowerShell uses
`$env:SESH_BUILD_QUEUE_HOME = 'C:\local\path'`.

## Cancellation and recovery

Ctrl+C or SIGTERM cancels waiting work and stops owned running process trees
before releasing their slots. POSIX uses an owned process group with bounded
TERM/KILL escalation; Windows uses `taskkill /T /F` for the current child.
Commands must wait for their own children and must not daemonize or recursively
invoke queued integrator commands. If termination cannot be verified, the slot
is retained for inspection. Cancellation is never a cached validation success
or an automatic transient retry.

The admission mutex is a short-lived exclusive loopback listener. It accepts no
requests and is closed after each queue transaction; the OS releases it on a
crash. There is no queue daemon or installed service. Waiting is bounded by a
deadline. A port collision or local network restriction fails closed with an
error; it never admits uncounted work. Queue inspection remains available.

Dead local waiting owners are safely removed on the next admission. A dead
**running** owner may have surviving children, so its slot stays occupied and new admissions pause until recovery. Age,
PID reuse, foreign-host records, malformed records, and permission errors never
justify automatic release. If a PID was reused, recovery refuses until ownership
can be established; do not kill that PID to clear the queue.

To recover a valid orphaned entry:

1. Run `seshx queue status` and identify its session, worktree and owner.
2. Inspect the workload in the OS process tools (for example `ps` on Linux/macOS,
   or Task Manager on Windows). Confirm the original CLI and **all** its build/test
   descendants have stopped. Do not terminate an unrelated or reused PID.
3. Only after that confirmation, run
   `seshx queue recover <entry-id> --confirmed-stopped`.
4. Retry the interrupted `validate` or `resume` using its pinned coordinator.
   Recovery changes no session, Git state, or validation result.

Recovery rechecks the owner under the admission mutex and refuses live, foreign
or ambiguous ownership. Unreadable/corrupt entries require manual inspection;
retain the evidence and stop all participants before repairing queue files.
Do not blindly delete the queue to bypass a stop.

## Validation and caching

Scheduling does not remove, reorder across sequential steps, or substitute any
configured pre-promotion checks. Cache hits require matching tree, command, platform, runtime and execution
environment fingerprints. Environment values are hashed, never persisted; `PWD`
and `OLDPWD` are excluded because worktree paths inherently differ. Older
fingerprints are conservatively missed once because they lack environment evidence.
Only uncached commands consume execution slots; inferred preparation is skipped
when every requested check is already cached. Failure or
cancellation never records a successful result. Parallel siblings settle before
the lifecycle proceeds or releases its repository/resource locks.

With `validationCache: "repository"`, identical concurrent validation plans in the
same repository/runtime share one run. A bounded, OS-owned mutex stays held through
tree verification and cache publication. Waiters recheck the verified cache after
acquiring it. Different trees, plans or environments use separate mutexes. Session
caching remains the default; no repository is silently opted into broader reuse.

Only enable repository caching for checks whose result depends on the tracked tree,
command and environment, independent of worktree path, untracked inputs and external
mutable services. Checks must not need per-worktree output artifacts or side effects.
Use `session` or `off` otherwise. This is result reuse, not build-artifact distribution.
Different repositories never share validation results. Separate runtime homes keep
separate caches even when they share queue capacity.

Cancellation of a reuse waiter leaves the owner running. A crashed owner's mutex is
released by the OS; no success is published before verification. Its running queue
entries still require the normal orphan recovery before new commands can start.
Full local-target recovery continues to bypass validation reuse.

## Measurement

Build first, then run:

```sh
pnpm build
node scripts/benchmark-build-queue.mjs /tmp/queue-results.json
```

The benchmark uses disposable Git repositories and an isolated queue. It compares
four directly launched sessions with queue limits of one and two. Each session
runs a real TypeScript check and a fixed memory/CPU test. It records completion
time, failed sessions, and sampled summed process-tree RSS across three rotated
repetitions. RSS sampling currently requires Linux `/proc`; it includes parent
process overhead, double-counts shared pages, and can miss peaks between samples.
It does not impose memory pressure or claim to measure an OOM threshold.

See [the recorded local results](build-queue-results.md) for measurements and
platform coverage. Native Windows queue smoke coverage passed; native macOS execution remains
unverified.

For the follow-up speed comparison against actual earlier installations:

```sh
node scripts/benchmark-validation-reuse.mjs /tmp/reuse-results.json /path/to/pre-queue/dist /path/to/queued/dist
```

This measures four concurrent validation sessions in separate worktrees of two
repositories, with independent checks and explicitly cacheable matching checks.
See [speed comparison results](validation-reuse-results.md).
