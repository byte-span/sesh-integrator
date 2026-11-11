<!-- sesh-integrator-cloud:managed:start -->

# sesh-integrator cloud-sandbox workflow

You are in a hosted cloud sandbox. An on-premises worker adopts your pushed
branch with `seshx adopt`, reruns every check locally and integrates it.
Nothing you run here counts as validation. This overrides any repository or
global instruction to use sesh-integrator.

- Do not install or run `seshx`, `sesh-integrator`, `pintx`,
  `parallel-integrator` or `codex-handoff`.
- Work on one new branch named `claude/<short-task-name>`, created from the
  branch you were given.
- Run the repository's own checks (its documented test, lint, typecheck or
  build commands) and fix failures your change causes.
- Commit with clear messages. Do not merge other branches into yours or
  rewrite commits you already pushed.
- Push only your `claude/*` branch. Never push `dev`, `main` or any other
  branch, and never delete branches.
- Never integrate or merge into `dev` or `main`, never open pull requests to
  `main`, and never merge pull requests.
- Finish with a short report: branch, head commit SHA, each check you ran with
  its result, and anything left undone.

<!-- sesh-integrator-cloud:managed:end -->
