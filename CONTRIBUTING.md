# Contributing

Thanks for helping improve sesh-integrator. Small, focused contributions are welcome.

## Discuss and report

Use [GitHub issues](https://github.com/byte-span/sesh-integrator/issues) for bugs
and feature proposals. Discuss substantial changes before implementing them.
Include the CLI version, operating system, Node.js and Git versions, expected
behavior, actual behavior, and a minimal reproduction in a disposable repository.
Redact credentials, private source code, paths, and sensitive log contents.
For vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Local development

Use Node.js 20 or newer, Git, and pnpm 10.14.0 (the version in `package.json`).
CI currently exercises Linux and macOS with Node.js 20, 22, and 24.

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm test
pnpm benchmark:check
```

`pnpm test` builds the CLI first. The standard suite uses disposable Git
repositories and fake harness executables; provider credentials are not needed.
Run focused tests while developing, then the checks above before submitting.
Real signing checks are optional and documented in the README.

Read [AGENTS.md](AGENTS.md), [SPEC.md](SPEC.md), [TASKS.md](TASKS.md),
[LEGACY_MIGRATION.md](LEGACY_MIGRATION.md), [README.md](README.md), and the
[workflow skill](skill/sesh-integrator-workflow/SKILL.md) before implementing.
When using sesh-integrator to develop itself, follow the
[stable coordinator workflow](docs/development.md#developing-sesh-integrator-concurrently).
Keep the coordinator outside source worktrees, pin its path, and target local
`dev`. Never use the candidate build to coordinate its own integration.
Maintainer machine safeguards are optional and are not required to run tests.

## Changes and pull requests

- Preserve uncommitted user work, exact-commit integration, locking, and safe
  target promotion. Do not weaken safety checks to make a test pass.
- Add focused regression coverage for behavior changes. Keep fixtures disposable
  and ordinary CI independent of live AI providers and credentials.
- Use TypeScript with strict types and minimal dependencies. Update documentation
  for CLI or configuration changes.
- Keep commits focused. Explain the problem, resulting behavior, and validation
  in the pull request, including any checks you could not run.
- AI-assisted contributions follow the same review and testing requirements.
  Review generated changes yourself before submitting.

External contributors should fork the repository and submit a focused pull
request against `dev`; maintainers coordinate promotion from `dev` to `main`.
Request review from `scram-j` when GitHub permissions allow it; otherwise ask a
maintainer to add the review request. Maintainer-managed sessions follow the
local task-branch policy in `AGENTS.md`.

## License

By submitting a contribution, you agree that it is provided under the project's
[MIT License](LICENSE). Only submit work you have the right to contribute.
