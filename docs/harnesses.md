# Coding harnesses

[Back to the README](../README.md)

Commands below run from the repository root unless stated otherwise.

- [Shared harness configuration and maintenance](#shared-harness-configuration-and-maintenance)
- [Documented adapter differences](#documented-adapter-differences)
- [Opt-in live conflict evaluations](#opt-in-live-conflict-evaluations)

For a small live connectivity check using existing logins, run
`pnpm test:ping:live --harness claude,antigravity,grok` or
`pnpm test:ping:live --installed`. See [ping behavior and limits](../smoke/README.md#minimal-live-connectivity-ping).

Install the shared workflow and global instructions for each harness you use:

```bash
seshx setup --harness claude
seshx setup --harness antigravity
seshx setup --harness grok
```

Setup preserves personal text outside the managed instruction block and leaves
repository instructions untouched. The legacy `scripts/install-skill.sh` keeps
its no-argument Codex default and positional custom skill directory support.

| Harness                       | Identifier    | User skill directory                | Global instructions   |
| ----------------------------- | ------------- | ----------------------------------- | --------------------- |
| Codex CLI                     | `codex`       | `~/.agents/skills/`                 | `~/.codex/AGENTS.md`  |
| Claude Code                   | `claude`      | `~/.claude/skills/`                 | `~/.claude/CLAUDE.md` |
| Antigravity CLI               | `antigravity` | `~/.gemini/antigravity-cli/skills/` | `~/.gemini/GEMINI.md` |
| Grok Build (official xAI CLI) | `grok`        | `~/.grok/skills/`                   | `~/.grok/AGENTS.md`   |

Each skill directory contains `sesh-integrator-workflow/SKILL.md`. These commands
use the standard user directories under HOME. Custom harness home directories
require installing the skill and global instructions at the corresponding custom
paths yourself; doctor checks the standard paths.

```bash
seshx doctor --harness claude
seshx begin --harness claude --create-worktree --summary "Implement the change"
```

Substitute `antigravity` or `grok` as appropriate. Session status records the harness;
old sessions and omitted flags retain Codex behavior. All four use the same
commit, validation, integration, checklist, and recovery commands. Conflicts are
resolved by the active agent, followed by `seshx resume`. Claude and Gemini project
instructions are included alongside `AGENTS.md` in saved conflict context.

All harnesses support current-session recovery and optional nested resolution.
Antigravity uses the neutral incident fallback; automatic diagnosis is disabled
because its plan mode does not enforce read-only access. Other harnesses support
automated incident diagnosis. One runner owns time limits, prompt delivery, error
handling, and response decoding; shared incident validation rejects malformed
results and preserves a neutral fallback. Nested agents edit conflict contents; seshx verifies the integration HEAD and
checks for leftover markers before staging the original conflicted paths. All
Git checks remain in the shared lifecycle. Tests use fake CLIs and disposable repositories; live authenticated
agent behavior is not covered by automated tests.

Antigravity replaces Gemini in new setup and session selections. Legacy Gemini
session IDs, command overrides, usage records, and recovery adapters remain
readable and are not rewritten to run a different executable. Finish those
sessions with their retained coordinator. Existing Gemini skills are preserved;
install the Antigravity workflow with `seshx setup --harness antigravity` after
upgrading the coordinator. `GEMINI.md` remains Antigravity's native rules filename.
The live Antigravity ping uses plan mode and existing account permissions; it
does not provide the tool-free isolation available in the other ping adapters.

### Shared harness configuration and maintenance

`harnesses.json` is the single registry of harness names, installation paths, and
native skill metadata. Both the CLI and installation scripts consume it.

```json
{
  "conflictResolutionMode": "nested-agent",
  "harnessCommands": {
    "codex": "codex",
    "claude": "claude",
    "antigravity": "agy",
    "grok": "grok"
  }
}
```

These optional fields belong in the existing global config. Executables default
to the harness identifier, except Antigravity which uses `agy`. `codexCommand` remains a legacy fallback for Codex;
`harnessCommands.codex` takes precedence. Current-session remains the default.

`scripts/install-skill.sh --installed` refreshes all installed workflows and their
global instructions. The machine safeguard installer uses it; post-merge hooks
do not refresh workflows or global instructions.
`seshx doctor --installed` checks those same installations and reports failure if
any fails. Scheduled health checks and macOS upgrade checks use this mode.
An installed workflow is identified by its native `sesh-integrator-workflow/SKILL.md`;
unused harnesses are not installed by bulk refresh or machine safeguards. On a
fresh installation, run `seshx setup` or choose a harness with `seshx setup --harness <name>`
before running the health check. The no-argument Codex default
and positional custom-directory installer remain compatible.

### Documented adapter differences

- Codex supports schema/output files and sandbox modes; its existing isolated
  `CODEX_HOME` handling remains internal to that adapter.
- Claude uses print-mode JSON and native structured output, restricted tools,
  and plan/acceptEdits permissions. Bare mode disables automatic plugin/hook discovery.
- Antigravity uses `agy --print`, JSON success status and response, sandboxed
  terminal commands, and accept-edits mode for resolution. Existing user
  permissions still apply. Plan mode is not a read-only boundary.
- Grok uses a prompt file, JSON containing `text`, native read-only/workspace
  sandbox profiles, and tool/permission filters. Automatic updates are disabled
  for these one-shot calls.

CLI permission/sandbox guarantees differ and can be constrained by managed
policy. No adapter requests a blanket permission bypass. Unsupported flags,
missing authentication, rejected tools, and invalid diagnoses fail safely;
update the CLI or continue recovery in the current session. Grok diagnoses
are validated locally against the same required fields as native structured outputs.

The legacy audit still targets the historical `codex-integrator` daemon because
that is the legacy system being detected; it is available from every harness.

References: [Claude skills](https://code.claude.com/docs/en/skills),
[Antigravity skills](https://antigravity.google/docs/cli/plugins/),
[Grok skills](https://docs.x.ai/build/features/skills-plugins-marketplaces),
[Grok global rules](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md).

Execution references: [Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Antigravity headless output](https://antigravity.google/docs/cli/headless/),
[Antigravity modes](https://antigravity.google/docs/cli/modes/),
[Grok headless flags and output](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md),
[Grok sandbox profiles](https://docs.x.ai/build/features/sandbox).

### Opt-in live conflict evaluations

Run `pnpm test:eval:live --harness codex --scenario 1` for a selected real-model
evaluation, or omit `--scenario` to select all twelve. `--trials 3` repeats each
case. These use disposable repositories, print usage, and never run as part of
ordinary tests. See [evaluation cases, grading, and reports](../eval/README.md).

The only maintained workflow skill is `sesh-integrator-workflow`. CLI aliases
such as `parallel-integrator` remain supported independently. Legacy skill
copies are not refreshed; archive them outside harness skill directories to
avoid duplicate discovery.
