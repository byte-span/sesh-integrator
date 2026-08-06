# codex-handoff global workflow

For code-changing work inside a Git repository:

1. Use `$codex-handoff-workflow` before making edits.
2. If the repository is not registered with `codex-handoff`, ask whether to register it.
3. If approved, register it and begin the handoff session.
4. Do not use this workflow for read-only questions or investigations that make no code changes.
5. Do not begin the workflow on the repository default branch or `codex-handoff/integration`.
6. Before declaring coding work complete, use the same skill to validate, create a focused commit when safe, and run one-shot integration.
7. If integration fails or reports `needs_review`, report that state instead of claiming successful integration.
8. Do not invoke the legacy `codex-integrator` workflow for repositories using `codex-handoff`.
