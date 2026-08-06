# codex-handoff

A personal one-shot integration workflow for parallel Codex worktrees.

It is intended as a simpler alternative to an always-running watcher/daemon.

## Core Flow

```text
Codex starts coding task
→ codex-handoff begin records session/base commit

Codex finishes task
→ validates
→ creates focused source commit
→ codex-handoff integrate

codex-handoff
→ waits for per-repo lock if necessary
→ merges exact commit
→ asks Codex to resolve conflicts
→ runs integration tests
→ commits result
→ exits
```

## No Background Service

There is no:

- daemon
- watcher
- polling
- LaunchAgent
- long-running queue process

Simultaneous finishes are serialized with a short-lived per-repository lock.

## New vs Old

Keep these separate:

```text
OLD
~/Developer/tools/codex-integrator
~/.codex-integrator

NEW
~/Developer/tools/codex-handoff
~/.codex-handoff
```

New default integration branch:

```text
codex-handoff/integration
```

See `LEGACY_MIGRATION.md` before enabling the new workflow on real projects.

## Files in This Implementation Pack

```text
AGENTS.md
SPEC.md
TASKS.md
LEGACY_MIGRATION.md
INITIAL_PROMPT.md
GLOBAL_AGENTS_SNIPPET.md
config.example.json
skill/
└── codex-handoff-workflow/
    ├── SKILL.md
    └── agents/
        └── openai.yaml
```

## Build Location

Create:

```bash
mkdir -p ~/Developer/tools/codex-handoff
cd ~/Developer/tools/codex-handoff
git init
```

Copy this documentation pack into that repository.

Then start Codex there and paste the contents of:

```text
INITIAL_PROMPT.md
```

## Expected CLI After Implementation

```bash
codex-handoff init
codex-handoff audit-legacy

cd ~/Developer/my-project
codex-handoff register
codex-handoff begin --summary "Implement feature"
codex-handoff integrate --summary "Implemented feature and tests"
codex-handoff status
```

Normally the global skill will run `begin` and `integrate` for you.

## Each Managed Project Needs

Only:

1. Git repository
2. its own Codex branch/worktree
3. one-time `codex-handoff register`
4. validation commands configured in `~/.codex-handoff/config.json`
5. optional project `AGENTS.md`

No daemon code or skill files need to be copied into each project.

## Skill

Install one user-level skill:

```text
~/.agents/skills/codex-handoff-workflow/
```

Then add the supplied global guidance to:

```text
~/.codex/AGENTS.md
```

That makes Codex consistently check the handoff workflow at the start and end of code-changing tasks.

## Legacy System

Run:

```bash
codex-handoff audit-legacy
```

before real use.

The new tool should tell you what old daemon components are active and what to disable.

Do not run both integration systems against the same repository at the same time.

## Known Limitation

The skill workflow is instruction-driven. If a Codex session crashes before completion, no one-shot integration runs.

The source work remains on its branch/worktree and can be integrated later manually.

This is intentionally simpler than a continuously running daemon.
