# Coding harnesses

[Back to the README](../README.md)

Commands below run from the repository root unless stated otherwise.

- [Skill directories](#skill-directories)
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

Setup writes the managed instruction block for each selected harness and
installs the `sesh-integrator-workflow` skill into every detected harness skill
directory (see [skill directories](#skill-directories)). It preserves personal
text outside the managed block and leaves repository instructions untouched.
The legacy `scripts/install-skill.sh` keeps its no-argument Codex default and
positional custom skill directory support.

| Harness                       | Identifier    | Skill target      | Global instructions   |
| ----------------------------- | ------------- | ----------------- | --------------------- |
| Codex CLI                     | `codex`       | `agents`          | `~/.codex/AGENTS.md`  |
| Claude Code                   | `claude`      | `claude`          | `~/.claude/CLAUDE.md` |
| Antigravity CLI               | `antigravity` | `antigravity-cli` | `~/.gemini/GEMINI.md` |
| Grok Build (official xAI CLI) | `grok`        | `grok`            | `~/.grok/AGENTS.md`   |

Global instructions use the standard directories under HOME; custom harness
homes need the managed block copied there yourself. Skill directories follow
the overrides listed below.

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

### Skill directories

seshx installs its skill under the agent skill install contract
(`agent-skill-contract/1.1`, harness list `2026-11-13`, in
`src/skill-contract.mjs`). A directory is a target when any of its detection
paths exists:

| Target                   | Directory                                                                          | Harnesses served                        | Detected by                                           |
| ------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| `agents`                 | `~/.agents/skills`                                                                 | Codex, Gemini CLI                       | `~/.agents`, `$CODEX_HOME` or `~/.codex`, `~/.gemini` |
| `claude`                 | `$CLAUDE_CONFIG_DIR` or `~/.claude`, then `/skills`                                | Claude Code, Cursor, GitHub Copilot CLI | that directory, `~/.cursor`, `~/.copilot`             |
| `grok`                   | `~/.grok/skills`                                                                   | Grok Build                              | `~/.grok`                                             |
| `antigravity-cli`        | `~/.gemini/antigravity-cli/skills`                                                 | Antigravity CLI                         | `~/.gemini/antigravity-cli`                           |
| `antigravity-ide`        | `~/.gemini/config/skills`                                                          | Antigravity IDE                         | `~/.gemini/config`                                    |
| `antigravity-ide-legacy` | `~/.gemini/antigravity/skills`                                                     | Antigravity IDE (legacy)                | `~/.gemini/antigravity`                               |
| `opencode`               | `$OPENCODE_CONFIG_DIR` or `${XDG_CONFIG_HOME:-~/.config}/opencode`, then `/skills` | OpenCode                                | that directory                                        |
| `pi`                     | `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, then `/skills`                            | Pi                                      | that directory                                        |

Cursor, GitHub Copilot CLI and Gemini CLI read a shared directory, so they get
no separate copy. `~/.codex/skills` is not a target; it holds Codex built-ins.
Setup also creates the directory of each harness you select, so its copy is
installed even before the harness has run once.

Each copy is the whole bundled folder, `SKILL.md` plus `agents/openai.yaml`,
with `managed-by`, `managed-version`, `managed-command` and `managed-hash`
stamped into the `SKILL.md` frontmatter `metadata`. `seshx skill status` shows
each target's state:

| State         | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `missing`     | not installed there                                      |
| `current`     | installed by seshx, unedited, same as this CLI's skill   |
| `stale`       | installed by seshx, unedited, from another seshx version |
| `legacy`      | an unstamped copy that an earlier seshx installed        |
| `unmanaged`   | a copy seshx did not install                             |
| `other-owner` | a copy another tool manages                              |
| `edited`      | installed by seshx, then changed                         |
| `error`       | the directory could not be read or written; see message  |

Normal seshx commands update `legacy` copies and `stale` copies from an older
version, never add a missing copy and never downgrade, so older pinned
coordinators cannot undo a newer copy. `AGENT_SKILL_HEAL=0` turns that off.
`seshx skill`, `setup`, `uninstall` and the read-only `doctor` never heal.
`unmanaged` and `edited` copies are replaced only with `--replace-unmanaged` or
`--replace-edited`, which first move them to `skill-backups/` in the runtime
directory. A newer copy is replaced only with `--allow-downgrade`.
`seshx uninstall` removes owned copies for the removed harnesses, and from every
target once no harness remains enrolled.

Every write holds a per-skill lock, `.sesh-integrator-workflow.lock` in that
skills directory, so parallel seshx runs never collide. `install`, `remove` and
setup wait up to 10 seconds for it. Normal runs never wait: they skip a
directory another process is updating and stay silent about it. The next
install removes leftover `.sesh-integrator-workflow.installing-<pid>` and
`.sesh-integrator-workflow.replaced-<pid>` folders from crashed runs. seshx only ever reads its own
folder in a skills directory, so these dot entries never appear as skills.

The harness list is frozen per contract version. If a vendor documents a
different path, report it with the source link instead of changing it here.

### Shared harness configuration and maintenance

`harnesses.json` is the single registry of harness names, global instruction
paths, and each harness's skill target. Both the CLI and installation scripts
consume it.

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
An installed workflow is identified by the managed block in its global
instructions file. The skill alone does not enroll a harness, so unused
harnesses get no managed block from bulk refresh or machine safeguards. On a
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
