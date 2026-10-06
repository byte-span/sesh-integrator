# Build queue measurements

Measured on October 6, 2026, in Linux/WSL with Node 24.21.0, 16 available CPU
threads and 7.5 GiB OS memory. The resource-aware default on this machine is one
slot. Three repetitions per mode used four concurrent sessions in two disposable
Git repositories and four runtime homes. Each session ran TypeScript over 1,800
typed declarations, then a 96 MiB memory scan for 500ms.

| Mode    | Median completion | Median peak RSS | Maximum peak RSS | Failed sessions |
| ------- | ----------------- | --------------- | ---------------- | --------------- |
| direct  | 1.627s            | 1061 MiB        | 1067 MiB         | 0/12            |
| queue-1 | 4.974s            | 553 MiB         | 568 MiB          | 0/12            |
| queue-2 | 2.789s            | 708 MiB         | 714 MiB          | 0/12            |

At two slots, median peak process-tree RSS fell by 33% compared with unrestricted
direct launches. Completion took 2.789s instead of 1.627s. One slot reduced median
peak RSS by 48%, taking 4.974s. This demonstrates a memory/throughput tradeoff,
not a universal speedup or a reduction in observed failures: all 36 sessions
succeeded, and no memory-pressure/OOM condition was imposed.

Peak RSS is the sum of the benchmark parent and descendant process RSS, sampled
from `/proc` every 20ms. Shared pages are counted more than once and short peaks
can be missed. Mode order rotated; filesystem caches were warm. Other machine
activity was not controlled. The measurements concern this fixture, not every
repository's workload. [Raw observations](build-queue-results.json) retain each
run's timing, peak memory and failures.

## Recovery and platform checks

Focused tests cover concurrent processes/repositories/runtime homes, limits one
and two, changing capacity, cached results, failed parallel groups, bounded
waiting, cancellation of running and waiting work, cancellation while waiting
for named resources, stale waiting ownership, live/foreign/corrupt records,
abrupt owner death with a surviving real workload, confirmed recovery, and OS
admission-mutex release after a crash.

`node scripts/smoke-build-queue.mjs` also passed on Linux/WSL (Node 24.21.0) and
native Windows (Node 24.19.0): four jobs respected two slots and cancellation
stopped a parent/child process tree and released its slot. The Windows smoke
invokes the registered signal handler explicitly, so it does not verify terminal
Ctrl+C delivery. This is queue-specific coverage, not certification of the entire
CLI on Windows. Native macOS execution remains unverified.

Reproduce with the commands in [build queue measurement](build-queue.md#measurement).
