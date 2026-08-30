# codex-handoff global workflow

For most code-changing tasks inside a Git repository, use `codex-handoff` from
the current Codex CLI checkout. Do not use it for read-only work, non-Git
directories, or changes to the `codex-handoff` repository itself. Do not invoke
the legacy `codex-integrator` workflow for repositories using `codex-handoff`.

Operate autonomously by default. Do not ask for routine approval to register,
begin, validate, commit, integrate, resume, or safely promote local work that is
already within the user's request.

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
- Make cross-repository registry edits through their own `codex-handoff`
  session. If the app ID cannot be established from existing non-secret project
  metadata, do not guess; finish safe application work and report the missing
  registry metadata for trusted follow-up.

Before editing:

1. Inspect the repository instructions and Git state. Preserve all pre-existing
   user changes; never reset, overwrite, discard, clean, or silently stash them.
2. Inspect `codex-handoff status`. Continue an active or recoverable session
   attached to the current source worktree when it belongs to the same task.
   An unrelated session launched from the same ordinary checkout does not block
   a new isolated task; begin another managed worktree. Never replace or
   overwrite a session for a different task.
3. If the repository is unregistered, run:

   ```bash
   codex-handoff register --auto-config
   ```

   Registration is automatic and does not require routine approval.
   Before beginning, compare the effective target shown by
   `codex-handoff status` with the repository's branch policy. If agents must
   work on a branch such as `dev` while `main` remains stable, set the global
   `defaultTargetBranch` to `dev` in `~/.codex-handoff/config.json`. This policy
   applies automatically to existing and new registrations that omit a
   repository `targetBranch`; use that per-repository field only for explicit
   exceptions.

4. If no appropriate session exists, run:

   ```bash
   codex-handoff begin --create-worktree --summary "<concise task summary>"
   ```

   From an ordinary checkout, `--create-worktree` creates a unique task branch
   in a separate source worktree and prints `Continue task in: <path>`. Perform
   every subsequent file edit and handoff command from that path. If the CLI
   session already started in a linked worktree, the command reuses it. The
   launch checkout and all dirty or staged user state there remain untouched;
   never copy that state into the task worktree unless the user explicitly
   makes it part of the task.

5. Never begin on `codex-handoff/integration` (or the repository's configured
   integration branch). Pass `--depends-on` only for explicit dependencies.

At completion:

1. Inspect the task diff and Git status. Stage only intended task paths and
   preserve unrelated state.
2. Create one focused source commit through:

   ```bash
   codex-handoff commit --message "<focused commit message>"
   ```

3. Run `codex-handoff validate`; do not integrate if validation fails.
4. Run `codex-handoff integrate --summary "<concise completion summary>"
--rollout <none|applied|automated|manual>`. Every integration must classify
   external-state rollout. `manual` also requires one or more explicit
   `--follow-up "<required action>"` arguments. Source promotion never implies
   external state was applied.
5. For a resumable conflict, resolve and stage the preserved integration
   worktree without committing there, then run `codex-handoff resume` from the
   original source checkout. Preserve compatible intent and continue
   autonomously unless the conflict is genuinely ambiguous or validation fails.
6. For `promotion_pending`, preserve the validated staging commit, correct only
   the reported blocking condition without disturbing user state, and run
   `codex-handoff resume`. Do not claim success until promotion and configured
   post-integration checks complete.
7. Report the session, source commit, staging integration commit, target branch
   and promoted commit, pull-request URL when present, and every required manual
   follow-up step. Requests for concision never override these required fields.
   Use the CLI's compact `Completion summary` block as the reporting baseline.
   If no manual steps remain, state `No manual follow-up required.`

Never push, force-push, deploy, or perform destructive remote actions unless the
user clearly requests that specific external action. Never delete branches or
worktrees, reset a user checkout, discard changes, or trade away user state to
make handoff succeed.
