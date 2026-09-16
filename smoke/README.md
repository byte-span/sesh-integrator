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

Use a trusted, reviewed checkout on Linux or macOS. Install the harness CLIs to
be tested and prepare a **separate sandbox home outside the repository** with
sandbox-only authentication. Never use a Production account, your normal home,
or credentials available to unreviewed fork jobs. Configure authentication on a
trusted machine; do not put credential values in commands, source, or reports.

Set a provider-enforced spending limit before acknowledging the budget below.
A timeout limits elapsed time, not money. The runner cannot establish billing
caps for you. The sandbox home must contain only the intended harness settings
and authentication: no additional MCP servers, hooks, skills, or integrations.
Ambient credential environment variables are deliberately not forwarded. Use
file-based sandbox login supported by each installed harness; Codex reads the
sandbox home's `.codex` configuration through the existing adapter.

```sh
SESH_SMOKE_HOME=/absolute/path/to/sandbox-home \
SESH_SMOKE_BUDGET_CONFIRMED=1 \
pnpm test:smoke:live --all
```

Select individual harnesses with flags:

```sh
pnpm test:smoke:live --harness codex
pnpm test:smoke:live --harness codex,claude
pnpm test:smoke:live --all
pnpm test:smoke:live --help
```

The sandbox home and budget environment variables above still apply to each
live run. `--help` needs neither and makes no calls. Explicit selection flags
override `SESH_SMOKE_HARNESSES`; the environment variable remains supported
when no selection flag is supplied. `--harness` and `--all` cannot be combined.
Unknown names, duplicates, empty lists and unsupported arguments are rejected
before building or invoking providers.

Choose one or more comma-separated harness names. Missing/unknown harnesses,
missing budget acknowledgement, and missing/ordinary home paths fail the run;
they never silently skip into a passing result. This command is separate from
normal CI and is not scheduled automatically.

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
The supplied sandbox home remains in place. This is process/home isolation,
not a container or security boundary against a malicious harness.

Record the tested CLI versions and outcomes in release review. Run all four
before advertising all four as live-verified; a deterministic CI pass does not
establish live provider compatibility. Failure and timeout recovery stay in the
credential-free suite so their coverage does not depend on provider outages.
