# sesh-integrator global workflow

For most code-changing tasks inside a Git repository, use the installed `sesh-integrator` CLI. Do not use it for read-only work, non-Git
directories, or its configured integration branch. Do not invoke
the legacy `codex-integrator` workflow for repositories using `sesh-integrator`.

Operate autonomously by default. Do not ask for routine approval to register,
begin, validate, commit, integrate, resume, or safely promote local work that is
already within the user's request.

Supported harnesses are Codex CLI (`codex`), Claude Code (`claude`), Antigravity CLI
(`antigravity`), and Grok Build (`grok`). When beginning a session, pass
`--harness <your-harness>` with the matching identifier; omission means Codex
for compatibility. Use the same identifier with `seshx doctor --harness`.
Resolve conflicts and inspect failure evidence in the current agent session.
Optional nested resolution (`conflictResolutionMode: "nested-agent"`) and
automated incident investigation use the session's recorded harness.
Antigravity automated diagnosis uses a neutral fallback because plan mode is not
enforced read-only. All harnesses share the Git lifecycle; keep exceptions limited to documented
harness behavior. `seshx doctor --installed` checks every installed workflow.
Read repository `AGENTS.md` and your harness's project instructions, such as
`CLAUDE.md` or `GEMINI.md`, before editing.

When developing `sesh-integrator` itself, follow its repository instructions:
use isolated source worktrees and a stable installed coordinator outside the
source repository. Pin the resolved coordinator CLI path for the entire session,
including resume, and run lifecycle commands through that path. Never coordinate
integration with the candidate build being modified or replace the coordinator
during unfinished sessions. See the repository README for snapshot installation.

Use `seshx` as the preferred command. `sesh-integrator`, `pintx`,
`parallel-integrator`, and `codex-handoff` remain compatible aliases. Existing
runtime data and configured branch names remain in place.

Runtime paths below use the fresh-install default. If `SESH_INTEGRATOR_HOME`, `PARALLEL_INTEGRATOR_HOME`
or compatibility `CODEX_HANDOFF_HOME` is set, use that directory instead.
Otherwise reuse `~/.codex-handoff/` first, then `~/.parallel-integrator/` if present;
fresh installations use `~/.sesh-integrator/`. Do not move existing session or worktree data.

## Adoption and installation continuity

Repository-scoped registration/begin reports existing dirty work and managed
sessions. Isolated tasks may start from dirty launch checkouts; never import,
commit, stash, or discard old edits automatically. Global setup cannot discover
intended repositories or enroll already-open conversations. Inspect status in
each known repository and continue tasks by session ID.

New sessions retain a content-hashed coordinator and resource copy under the
runtime's `coordinators/` directory. `status --session <id>` identifies it and
reports missing assets. Keep the pinned coordinator for unfinished tasks;
compatible reinstall can recover if the original executable is missing.
`seshx installation-check` rejects incompatible state before installation changes.
Do not run older pre-contract executables on newer session records.

Uninstall stops new enrollment for selected harnesses and defers guidance removal
while their sessions are unfinished. Existing sessions can finish using retained
executables; rerun uninstall afterward. Direct npm package removal can bypass
uninstall, so preserve runtime data, recovery bundles and Git refs. Reinstall with
the same runtime home and a compatible build. Never remove an ambiguous lock to
make installation or recovery proceed.

## External services and production isolation

- This is an agent-accessible development VM, not a Production administration
  environment. Never retrieve, store, or request Production secrets,
  provider-administration credentials, deployment tokens, or Production log
  access here or through agent-accessible tools and connectors.
- Projects may use normal external-service SDKs and HTTPS APIs in server-side
  code. Implement Production integrations against environment-variable names
  and deployment-provider configuration without obtaining the secret values.
- Keep privileged integration code out of client bundles. Use publishable keys
  client-side only when the provider explicitly designs them for public use.
- Fake, local, or vendor-sandbox credentials may be used when needed. Keep them
  outside repositories, scope and cap them where possible, and assume agents
  can read and use them.
- Never provide Production secrets to tests, previews, or CI jobs that run
  unreviewed code. Production code must pass trusted review on the protected
  Production branch before the deployment environment supplies its secrets.
- Do not print or persist credentials, authorization headers, signed URLs, full
  environment objects, or sensitive vendor responses. If Production access is
  required, finish safe code and sandbox work and report the trusted manual
  follow-up instead of weakening this boundary.
- A credential gateway is optional. Prefer it only for unusually powerful or
  shared credentials, or tightly limited access from less-trusted Production
  workloads.

## Central secret requirements

- The reviewed, non-secret registry is
  `~/code/secret-sync/secret-configs/apps/<app-id>.json`. When application code
  adds, renames, or removes a server-side Production secret requirement, inspect
  and update that app's registry entry as part of the task.
- Registry files may contain only the schema version, app ID, provider name,
  optional non-secret Vercel project name, and exact environment-variable
  names. The project name defaults to the app ID. Never place values, tokens,
  ciphertext, credentials, Vercel project/organization IDs, or copied
  Production data there. Druidia uses one encrypted global Vercel token/team
  default with optional encrypted per-app overrides and resolves only the
  declared project name.
- Use normal environment-variable names without app/proxy prefixes. Keep names
  sorted and run `npm run validate:configs` in `secret-sync` after changes.
- Make cross-repository registry edits through their own `sesh-integrator`
  session. If the app ID cannot be established from existing non-secret project
  metadata, do not guess; finish safe application work and report the missing
  registry metadata for trusted follow-up.

Check `seshx status` for the current repository's enablement before registration
or session recovery. If it reports `Enablement: disabled`, skip this workflow
and follow the repository's normal development instructions. Do not automatically
register, begin, resume, or run `seshx enable` to bypass an opt-out. Registration
and enablement are independent; registration never clears a disabled setting.
Only enable the repository when the user requests it.

Before editing:

1. Inspect the repository instructions and Git state. Preserve all pre-existing
   user changes; never reset, overwrite, discard, clean, or silently stash them.
2. Inspect `seshx status`. Continue an active or recoverable session
   attached to the current source worktree when it belongs to the same task.
   An unrelated session launched from the same ordinary checkout does not block
   a new isolated task; begin another managed worktree. Never replace or
   overwrite a session for a different task.
3. If the repository is unregistered, run:

   ```bash
   seshx register --auto-config
   ```

   Registration is automatic and does not require routine approval.
   Before beginning, compare the effective target shown by
   `seshx status` with the repository's branch policy. If agents must
   work on a branch such as `dev` while `main` remains stable, set the global
   `defaultTargetBranch` to `dev` in `config.json` under the effective `Runtime:` directory shown by `seshx status`. This policy
   applies automatically to existing and new registrations that omit a
   repository `targetBranch`; use that per-repository field only for explicit
   exceptions.

4. If no appropriate session exists, run:

   ```bash
   seshx begin --create-worktree --summary "<concise task summary>"
   ```

   From an ordinary checkout, `--create-worktree` creates a unique task branch
   in a separate source worktree and prints `Continue task in: <path>`. Perform
   every subsequent file edit and handoff command from that path. If the CLI
   session already started in a linked worktree, the command reuses it. The
   launch checkout and all dirty or staged user state there remain untouched;
   never copy that state into the task worktree unless the user explicitly
   makes it part of the task.

5. Never begin on `sesh-integrator/integration` (or the repository's configured
   integration branch). Pass `--depends-on` only for explicit dependencies.

During work, maintain an ordered checklist for the session. After `begin` or
recovery, inspect `seshx tasks list`; create a new plan with
`seshx tasks add --title "<step>" [--title "<step>"]...` only when needed.
Tasks default to pending. Use `seshx tasks update <task-id> --status
in_progress` when starting work and `--status completed` when finished. Only
one task may be in progress. Blocked and skipped require `--reason "..."`.
Add newly discovered tasks, clarify titles/descriptions with `tasks update`, and
reorder with `tasks move <task-id> --position <n>`. IDs remain stable. Split work
by adding replacement tasks and skipping the original with a reason; keep
completed and skipped entries visible. Update promptly, including after
integration, so the dashboard reflects the actual plan. Use `--session <id>`
when needed; never directly edit session JSON or record secrets. Checklist
completion does not replace validation, integration, or external rollout checks.

### Finish when no changes are needed

If inspection shows the requested work is already implemented and this session
has no new changes, finish its checklist truthfully (skip unnecessary work with
reasons), then run:

```bash
seshx finish --no-changes --summary "<why no changes are needed>" [--session <id>] [--satisfied-by <successful-session-id>]
```

This is required before the final response; skipping tasks alone does not close
the session. The CLI verifies the unchanged source branch/commit and observable
working-tree baseline, rejects integration/recovery state and unfinished tasks,
and records `no_changes` without creating or promoting a commit. Never create an
empty commit or integrate just to close a no-change session. If an earlier
successful session already delivered the work, pass its ID with `--satisfied-by`;
the CLI verifies its source commit is present and retains its outstanding PR
review and rollout obligations. Report the current no-change session and the
referenced integration separately. Inspect `seshx status --session <id>` before
reporting completion. A terminal response does not update stored session status.

At completion:

1. Inspect the task diff and Git status. Stage only intended task paths and
   preserve unrelated state.
2. Create one focused source commit through:

   ```bash
   seshx commit --message "<focused commit message>"
   ```

3. Run `seshx validate`. Treat the complete failure output and exit code
   as evidence, not a verdict about whether the failure is deterministic. If
   retrying is plausibly safe, rerun the unchanged validation for at most three
   total attempts. Stop after repeated failure or evidence of a code defect; do
   not integrate without successful validation or edit code merely to make a
   retry pass.
4. Run `seshx integrate --summary "<concise completion summary>"
--rollout <none|applied|automated|manual>`. Every integration must classify
   external-state rollout. `manual` also requires one or more explicit
   `--follow-up "<required action>"` arguments. Source promotion never implies
   external state was applied.
5. For a resumable conflict, resolve and stage the preserved integration
   worktree without committing there, then run `seshx resume` from the
   original source checkout. Preserve compatible intent and continue
   autonomously unless the conflict is genuinely ambiguous or validation fails.
6. For `promotion_pending`, preserve the validated staging commit. If its owner
   committed previously dirty target work, run `seshx resume` to reconcile both
   histories in the isolated recovery worktree and fully revalidate. Resolve and
   stage conflicts there without committing, then resume. Each resume makes one
   local reconciliation attempt; further target movement stays pending. Never
   replace the saved expected SHA manually. Otherwise correct only
   the reported blocking condition without disturbing user state, and run
   `seshx resume`. Do not claim success until promotion and configured
   post-integration checks complete.
7. For `validation_pending`, inspect the preserved evidence and incident, then
   autonomously run `seshx resume` in the same session when retrying is
   safe, for at most three total attempts. Do not start a new session merely to
   retry integration.
8. Report the session, source commit, staging integration commit, target branch
   and promoted commit, pull-request URL when present, and every required manual
   follow-up step. Requests for concision never override these required fields.
   Use the CLI's compact `Completion summary` block as the reporting baseline.
   If no manual steps remain, state `No manual follow-up required.`

For each `--follow-up`, record one actionable outstanding step: what to do,
where to do it (system, repository/project, environment), and exact configuration
names when known. Verify names from non-secret source/configuration; do not
invent missing names. For credentials, record only names and destination and
say to configure them on a trusted machine. Never request, read, store, or print
secret values, including in CLI arguments or session records.

Before the final response, use the latest `Completion summary` (available again
with `seshx status --session <session-id>`) and check every recorded
action against the response. Preserve every outstanding action and its essential
details, even when concise: action, destination, exact names, and prerequisites.
Do not collapse setup into a label such as “complete CWS setup.” Documentation
links may supplement instructions but must not replace known essential steps.
Keep completed actions separate from outstanding ones. After successful recovery,
report resolved integration prerequisites as completed, not required follow-ups;
do not copy old errors or incident fixes into the outstanding list. Record only
outstanding external work in `--follow-up`, not prerequisites the session already
resolved. Recovery alone does not resolve recorded external setup actions. If an
external action was subsequently completed with evidence, explicitly report that
completion instead of silently omitting it or repeating it as outstanding.

Source promotion success is separate from external setup or rollout completion.
`automated` means delegated, not verified complete. Use `No manual follow-up
required.` only when no required actions remain, including review/merge and
unresolved prerequisites. Requests for concision never override these details.

Direct agent-issued pushes, force-pushes, deployments, PR merges, and destructive
remote actions require an explicit user request. An explicitly configured
`promotion.type: "pull-request"` authorizes the integrator itself to push the
configured target without force and create or update its configured PR. Never delete branches or
worktrees, reset a user checkout, discard changes, or trade away user state to
make handoff succeed.
