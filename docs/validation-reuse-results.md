# Parallel validation speed comparison

Measured before integration on Linux/WSL, Node 24.21.0, 16 available CPU threads,
7.5 GiB RAM. Five rotated repetitions per case, four concurrent validation sessions
in four separate worktrees of two disposable repositories. Each session requires
an unchanged TypeScript check over 1,800 declarations and a 96 MiB/500 ms memory
scan. Caches start empty for every case. Actual installed pre-queue and initial
queue modules are compared with the candidate build.

| Workload                                    | Revision              | Median completion | Median peak aggregate RSS | Failed sessions |
| ------------------------------------------- | --------------------- | ----------------: | ------------------------: | --------------: |
| Independent checks; caching off             | Pre-queue             |           1.589 s |                 1,040 MiB |            0/20 |
| Independent checks; caching off             | Initial queue default |           4.987 s |                   565 MiB |            0/20 |
| Independent checks; caching off             | Candidate             |           1.604 s |                 1,070 MiB |            0/20 |
| Matching checks; repository caching enabled | Pre-queue             |           1.627 s |                 1,066 MiB |            0/20 |
| Matching checks; repository caching enabled | Initial queue default |           5.109 s |                   581 MiB |            0/20 |
| Matching checks; repository caching enabled | Candidate             |           1.371 s |                   734 MiB |            0/20 |

Matching checks finished **15.7% faster** with **31.1% less peak RSS** than
pre-queue. Each candidate batch executed four commands and reused four verified
results; both older versions executed all eight. Compared with the initial
queue default, completion was 73.2% faster.

Independent checks finished 67.8% faster than the initial queue default, but
**0.9% slower than pre-queue** (15 ms). This is approximately parity within the
observed run-to-run variation, not evidence of a speedup for independent work.
Removing throttling also restores its higher memory use. There is no claim that
every workload is faster, that unrestricted scheduling prevents OOM, or that
failures improved: all 120 measured sessions passed.

These are validation-phase completion times, not complete editing, integration,
PR or deployment lifecycles. Required command coverage is unchanged. Repository
reuse remains opt-in and requires checks independent of worktree-specific
artifacts and external mutable state. Different repositories never share results.

RSS is sampled from `/proc` every 20 ms across the benchmark process and its
children. It includes sampler/coordinator overhead, double-counts shared pages,
and may miss peaks between samples. This was a warm-filesystem-cache run on a
shared development machine, without imposed memory pressure. Five repetitions
are descriptive evidence, not a statistical guarantee.

During development, an earlier candidate was 5% slower for independent work.
Combining queue registration/admission, reserving available slots for earlier
waiters, and shortening contention waits for the brief admission mutex reduced
that difference to the 0.9% reported above. The table and
[raw results](validation-reuse-results.json) describe the final algorithm only.

Reproduce after `pnpm build`:

```sh
node scripts/benchmark-validation-reuse.mjs /tmp/reuse-results.json /path/to/pre-queue/dist /path/to/initial-queue/dist
node scripts/smoke-build-queue.mjs
node scripts/smoke-validation-reuse.mjs
```

Focused tests cover matching-plan reuse, distinct trees/environments, disabled
caching, failed validation, failed post-validation verification, cancelled
waiters, owner crashes, orphaned workloads requiring explicit recovery, existing
queue limits, and cache hits avoiding unnecessary preparation. Portable smoke
scripts exercise process concurrency, cancellation of a process tree, and four
coordinators sharing one successful result. Native macOS remains unverified.
