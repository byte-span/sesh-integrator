# GPG Reliability Evidence

Recorded on 2026-08-09 UTC on macOS 15.6.1 (24G90), Apple Silicon.

## Pre-change diagnosis and backup

Observed configuration:

```text
git version 2.50.1 (Apple Git-155)
node v22.17.0
pnpm 10.14.0
commit.gpgSign=true
gpg.program=/usr/local/MacGPG2/bin/gpg2
MacGPG: GnuPG 2.2.32, libgcrypt 1.8.8
old Intel Homebrew GnuPG: 2.3.6, libgcrypt 1.10.1
canonical socket: /Users/j/.gnupg/S.gpg-agent
agent health: gpg-connect-agent: no gpg-agent running in this session
```

Before any attempted configuration change, configuration-only backups were
created at:

```text
/Users/j/.codex-gpg/backups/20260809T012141Z/codex-gpg
/Users/j/.codex-gpg/backups/20260809T012141Z/gitconfig
/Users/j/.codex-gpg/backups/20260809T012141Z/gpg-agent.conf
/Users/j/.codex-gpg/backups/20260809T012141Z/gpg.conf
```

All four files are mode `0600`. No keyring, trust database, revocation
certificate, or private-key directory was included.

## Implemented

- `parallel-integrator commit --message "..."` owns source commit creation for an
  active session, requires explicitly staged task paths, rejects mixed
  staged/unstaged task paths, and checks the recorded worktree baseline.
- Source, normal integration, resumed integration, and direct `commit-tree`
  commits perform a real in-memory OpenPGP signing preflight immediately before
  Git commit creation when `commit.gpgSign` is enabled.
- `scripts/codex-gpg` performs a `gpg-connect-agent --no-autostart` health
  check, requests `launchctl kickstart -k` recovery, retries for five seconds,
  and emits a specific recovery diagnostic.
- `scripts/install-gpg-reliability.sh` selects native
  `/opt/homebrew/opt/gnupg`, configures native pinentry-mac, installs a
  keepalive user LaunchAgent for the canonical `~/.gnupg` agent, disables and
  unloads only MacGPG's competing shutdown helper, updates Git without
  disabling signing, and backs up configuration on every run.
- `scripts/test-real-gpg-e2e.sh` is an explicit opt-in test using the real key,
  pinentry, a deliberately killed agent, a fresh worktree/session, a sandbox
  profile that denies writes to `~/.gnupg`, signed source and integration
  commits, `git verify-commit`, and private-material scans.

## Automated verification

Commands completed successfully:

```text
sh -n scripts/codex-gpg scripts/codex-gpg-agent scripts/install-gpg-reliability.sh
bash -n scripts/test-real-gpg-e2e.sh
plutil -lint scripts/com.codex.gpg-agent.plist
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
git diff --check
```

Test result:

```text
Test Files  3 passed (3)
Tests       48 passed (48)
```

The tests include fake-GPG integration signing and retry coverage, controlled
signed source commits, refusal before source commit when preflight fails,
launchd recovery, precise failed-recovery diagnostics, and rejection of
private material in the bridge.

Private-material scan result on 2026-08-09:

```text
find /Users/j/.codex-gpg/private-keys-v1.d -mindepth 1 -print
# no output
find /Users/j/.codex-gpg -path '*/private-keys-v1.d/*' \( -type f -o -type l \) -print
# no output
```

## Host activation blocker

The required native GnuPG installation was attempted with:

```text
/opt/homebrew/bin/brew install gnupg pinentry-mac
env HOMEBREW_CACHE=/private/tmp/parallel-integrator-homebrew-cache \
  HOMEBREW_TEMP=/private/tmp \
  /opt/homebrew/bin/brew install gnupg pinentry-mac
```

Both attempts were blocked by the Codex host sandbox:

```text
Error: /opt/homebrew/Cellar is not writable.
curl: (6) Could not resolve host: formulae.brew.sh
```

Consequently the installer was not activated, global Git still points to
MacGPG 2.2.32, and the real-key end-to-end test was not run. The source and
integration signature acceptance checks, deliberate-kill recovery proof, and
post-wake/post-login repetitions remain pending. No 97% confidence claim is
made until all of those checks pass.

## Remaining exact commands

Run outside the Codex sandbox:

```bash
cd /Users/j/Developer/tools/parallel-integrator
/opt/homebrew/bin/brew install gnupg pinentry-mac
./scripts/install-gpg-reliability.sh
PARALLEL_INTEGRATOR_REAL_GPG_E2E=1 ./scripts/test-real-gpg-e2e.sh initial
```

After waking the Mac and after a fresh login, respectively:

```bash
cd /Users/j/Developer/tools/parallel-integrator
PARALLEL_INTEGRATOR_REAL_GPG_E2E=1 ./scripts/test-real-gpg-e2e.sh after-wake
PARALLEL_INTEGRATOR_REAL_GPG_E2E=1 ./scripts/test-real-gpg-e2e.sh after-fresh-login
```

Each successful run prints and retains exact source/integration commit IDs,
signature verification output, versions, paths, agent state, and the disposable
evidence directory.
