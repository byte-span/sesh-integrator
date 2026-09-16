# Release smoke tests

## Credential-free CI

```sh
pnpm test:smoke
```

These tests also run automatically under `pnpm test`, including the existing
Linux/macOS CI matrix. No workflow change or provider credentials are required.

- Pack the built release, install its tarball offline with npm into a fresh
  prefix, and invoke the installed `seshx` executable.
- Check help, setup and doctor (using a version-only fake harness for doctor).
- Register a disposable repository, begin an isolated session, commit, validate,
  integrate and verify the exact promoted commit and its source ancestry.
- Preserve dirty tracked and untracked launch files, verify blocked promotion,
  save the fixture owner's edits and resume successfully.
- For every harness adapter, inject nonzero exit and a real subprocess timeout
  with a shortened deadline. Verify no target advancement, intact source state,
  preserved conflicts, and successful manual resolution/resume. These are
  deterministic fault tests, not claims about provider availability.

`test:smoke` builds first. The package test packs that build with pack scripts
skipped to avoid concurrent builds during the ordinary test suite; installation
still runs the actual package postinstall hook. Temporary repositories have no
remotes, separate runtime and home directories, and no inherited credentials or
Git user configuration. Test-owned temporary directories are removed afterward.

## Opt-in live harness tests

### Codex: use your existing login

From a trusted, reviewed checkout on Linux or macOS, with Codex already installed
and logged in, run:

```sh
pnpm test:smoke:live --harness codex
```

Invoking this explicit live command is consent to real AI calls using your
existing account and its usage limits. Codex requires no separate account,
`SESH_SMOKE_HOME`, or `SESH_SMOKE_BUDGET_CONFIRMED`. This command remains separate
from normal tests and is never scheduled automatically.

The smoke-only Codex launcher forwards the adapter's arguments (including
`--sandbox workspace-write`) and uses your current `CODEX_HOME`, falling back to
`~/.codex`. It also preserves your normal home and XDG configuration location
for the Codex process. Authentication files are not read or copied by the smoke
launcher. Codex itself uses its normal authentication and configuration, and may
update its usual session/login state. Account settings, configured integrations
and normal Codex usage charges still apply.

Disposable repositories, temporary integrator state, isolated Git configuration,
and timeouts remain automatic. No manual sandbox setup is needed. Other test
subprocesses retain their temporary home; normal CI does not inherit your login.
Ambient API-key variables are not forwarded. If your Codex configuration depends
on credentials supplied only through environment variables, that authentication
mode remains unsupported by this runner. An optional `SESH_SMOKE_HOME` explicitly
selects a different home's `.codex` directory instead of your current login.

### Other harnesses and combined runs

Claude, Gemini and Grok still require a separate `SESH_SMOKE_HOME` containing
sandbox authentication, and provider spending caps acknowledged with
`SESH_SMOKE_BUDGET_CONFIRMED=1`. Configure credentials on a trusted machine, never
in source or an unreviewed fork job. No Production credentials are required.
These requirements also apply when selecting them alongside Codex:

```sh
SESH_SMOKE_HOME=/absolute/path/to/sandbox-home \
SESH_SMOKE_BUDGET_CONFIRMED=1 \
pnpm test:smoke:live --all
```

### Selection and opt-in

```sh
pnpm test:smoke:live --harness codex
pnpm test:smoke:live --harness codex,claude
pnpm test:smoke:live --all
pnpm test:smoke:live --help
```

`--help` makes no calls. Explicit selection flags override
`SESH_SMOKE_HARNESSES`; the environment variable remains supported when no
selection flag is supplied. `--harness` and `--all` cannot be combined. Unknown
names, duplicates, empty lists and unsupported arguments are rejected before
building or invoking providers. The launcher marks its Vitest subprocess with
`SESH_SMOKE_LIVE_CONFIRMED=1`; direct Vitest invocation without that opt-in fails.

### Assertions and isolation

Each selected harness gets two adapter invocations, sequentially, without
retries or automatic AI incident diagnosis:

1. Make a tiny JSON edit; assert its semantics, unchanged Git HEAD, and no extra
   changed or untracked files.
2. Resolve a real two-session conflict through `seshx integrate` in nested-agent
   mode. Require both features to survive, integration validation to pass, the
   source commit to be an ancestor of the promoted target, clean worktrees, and
   the unrelated file to remain intact.

Each invocation has an outer two-minute process-group deadline. No pushes or
publishing occur. Provider output is captured in memory but omitted from test
failure messages; temporary integrator evidence is removed on completion.
Your normal Codex home and any supplied sandbox home remain in place. This is process/home isolation,
not a container or security boundary against a malicious harness.

Record the tested CLI versions and outcomes in release review. Run all four
before advertising all four as live-verified; a deterministic CI pass does not
establish live provider compatibility. Failure and timeout recovery stay in the
credential-free suite so their coverage does not depend on provider outages.

## Token usage reports

Every `pnpm test:smoke:live` run that reaches the live tests prints a usage report
on success or failure. It includes this run's total, a harness/model breakdown,
and rolling 1, 4, 12, and 24 hour totals across all harnesses. Windows count calls
by completion time (start time for interrupted calls). Cached reads are included
in input, never added to the total again. Provider totals are used when available.

Limits are unset by default. Set your own token thresholds for warnings, for example:

```bash
SESH_SMOKE_USAGE_LIMITS='{"1":100000,"4":300000,"12":600000,"24":1000000}' \
  pnpm test:smoke:live --harness codex
```

These are example limits, not defaults. A warning appears when the known total
exceeds a limit; equality does not warn. Warnings do not stop calls or change the
test result. Partial usage below a limit is shown as “cannot confirm below”.

History lives in `$XDG_STATE_HOME/sesh-integrator/smoke-usage`, or
`~/.local/state/sesh-integrator/smoke-usage` when XDG_STATE_HOME is unset.
`SESH_SMOKE_USAGE_DIR` overrides this with an absolute directory. To persist
limits, place the same JSON object in `limits.json` in that directory. The
environment setting replaces the file's limits. Omitted windows remain unset;
invalid settings fail before launching live tests.

Only instrumented live smoke calls sharing this directory count. This is not
account-wide usage, billing, subscription quota, or a dollar estimate. Missing
counts and models are explicitly unreported; failed or interrupted calls can
leave partial/unknown usage. If the launcher is forcibly killed, it cannot print
its report; durable pending records make the missing usage visible next run.
Unreadable history produces an incomplete-history warning. History is retained
until you remove it; deleting it resets the available rolling history.

Records contain timestamps, harness/model names, outcome, and normalized counts.
They do not contain prompts, answers, authentication data, or raw provider output.
Files are written atomically per call with private permissions, so concurrent
runs do not overwrite one another.

### Harness formats and future models

The shared ledger and report accept arbitrary model names. New harness formats
add an adapter in `src/usage-normalization.ts`; no reporting or history changes
are needed. An unsupported format produces unknown usage rather than zero.

- [Codex JSON events](https://learn.chatgpt.com/docs/non-interactive-mode):
  terminal turn usage; cached input is a subset of input. JSON output is enabled
  for tracked calls without changing sandbox or login settings.
- [Claude usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking):
  prefer `modelUsage`, including subagents, over aggregate usage. Add cache reads
  and writes to uncached input. Aggregate-only reports are marked partial.
- [Gemini headless statistics](https://geminicli.com/docs/cli/headless/):
  per-model prompt, candidate, thought, cached, and reported total counts.
- [Grok headless usage](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md):
  normalized cache-inclusive input. Headless totals exclude compaction and
  side-model work and are therefore marked partial.

For broader conflict-resolution quality checks, see the twelve opt-in
[live evaluation scenarios](../eval/README.md). Their calls share this usage
history and warning configuration.
