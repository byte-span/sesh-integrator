#!/bin/bash
set -euo pipefail

if [[ "${CODEX_HANDOFF_REAL_GPG_E2E:-}" != "1" ]]; then
  echo "Opt-in required: CODEX_HANDOFF_REAL_GPG_E2E=1 $0 [acceptance-label]" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
label=${1:-interactive}
gpg_prefix=${CODEX_GPG_PREFIX:-/opt/homebrew/opt/gnupg}
gpg_bin="$gpg_prefix/bin/gpg"
gpgconf_bin="$gpg_prefix/bin/gpgconf"
connect_bin="$gpg_prefix/bin/gpg-connect-agent"
wrapper=${CODEX_GPG_WRAPPER:-$HOME/.local/bin/codex-gpg}
canonical_home=${CODEX_GPG_CANONICAL_HOME:-$HOME/.gnupg}
bridge_home=${CODEX_GPG_BRIDGE_HOME:-$HOME/.codex-gpg}
launch_domain="gui/$(id -u)/com.codex.gpg-agent"
trial_root=$(mktemp -d "${TMPDIR:-/tmp}/codex-handoff-real-gpg.XXXXXX")
repo="$trial_root/repo"
runtime="$trial_root/runtime"
profile="$trial_root/codex-sandbox.sb"
cli="$project_dir/dist/cli.js"

for executable in "$gpg_bin" "$gpgconf_bin" "$connect_bin" "$wrapper"; do
  [[ -x "$executable" ]] || { echo "Missing executable: $executable" >&2; exit 69; }
done
command -v sandbox-exec >/dev/null || {
  echo "sandbox-exec is required to prove the denied ~/.gnupg write path" >&2
  exit 69
}

cat >"$profile" <<EOF
(version 1)
(allow default)
(deny file-write* (subpath "$canonical_home"))
EOF

echo "acceptance_label=$label"
echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "trial_root=$trial_root"
echo "repository=$repo"
echo "runtime=$runtime"
echo "canonical_home=$canonical_home"
echo "bridge_home=$bridge_home"
echo "wrapper=$wrapper"
sw_vers
git --version
"$gpg_bin" --version | sed -n '1,4p'
/bin/launchctl print "$launch_domain" | sed -n '1,45p'

pnpm --dir "$project_dir" build
git init -b main "$repo"
git -C "$repo" config user.name "Codex Handoff Real GPG"
git -C "$repo" config user.email "codex-handoff-real-gpg@local.invalid"
git -C "$repo" config commit.gpgSign false
printf 'base\n' >"$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit -m base

CODEX_HANDOFF_HOME="$runtime" node "$cli" init
CODEX_HANDOFF_HOME="$runtime" node "$cli" register "$repo"
node -e '
const fs = require("fs");
const path = process.argv[1];
const wrapper = process.argv[2];
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.repositories[0].gpgProgram = wrapper;
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
' "$runtime/config.json" "$wrapper"
git -C "$repo" config commit.gpgSign true

run_round() {
  local round=$1
  local mode=$2
  local worktree="$trial_root/worktree-$round"
  git -C "$repo" worktree add -b "codex/real-gpg-$round" "$worktree" main
  cd "$worktree"
  CODEX_HANDOFF_HOME="$runtime" node "$cli" begin --summary "real GPG $round $mode"
  printf '%s\n' "$round $mode" >"$worktree/$round.txt"
  git -C "$worktree" add "$round.txt"

  if [[ "$mode" == "after-deliberate-agent-kill" ]]; then
    GNUPGHOME="$canonical_home" "$gpgconf_bin" --kill gpg-agent || true
  else
    /bin/launchctl kickstart -k "$launch_domain"
  fi

  sandbox-exec -f "$profile" env CODEX_HANDOFF_HOME="$runtime" \
    node "$cli" commit --message "Real signed source $round"
  local source_commit
  source_commit=$(git -C "$worktree" rev-parse HEAD)
  sandbox-exec -f "$profile" env CODEX_HANDOFF_HOME="$runtime" \
    node "$cli" validate
  sandbox-exec -f "$profile" env CODEX_HANDOFF_HOME="$runtime" \
    node "$cli" integrate --summary "Real signed integration $round" --rollout none
  local integration_commit
  integration_commit=$(git -C "$repo" rev-parse codex-handoff/integration)
  local target_commit
  target_commit=$(git -C "$repo" rev-parse main)
  [[ "$target_commit" == "$integration_commit" ]] || {
    echo "target promotion mismatch: main=$target_commit staging=$integration_commit" >&2
    exit 1
  }
  git -C "$repo" -c "gpg.program=$wrapper" verify-commit "$source_commit"
  git -C "$repo" -c "gpg.program=$wrapper" verify-commit "$integration_commit"
  echo "round=$round mode=$mode source_commit=$source_commit integration_commit=$integration_commit target_commit=$target_commit"
}

(
  cd "$trial_root"
  run_round killed after-deliberate-agent-kill
  run_round restarted after-launchagent-restart
)

if [[ -d "$bridge_home/private-keys-v1.d" ]] &&
  find "$bridge_home/private-keys-v1.d" -mindepth 1 -print -quit | grep -q .; then
  echo "FAIL: private material exists in $bridge_home/private-keys-v1.d" >&2
  exit 70
fi
if find "$trial_root" -type d -name private-keys-v1.d -print -quit | grep -q .; then
  echo "FAIL: a private-keys-v1.d directory exists in the disposable trial" >&2
  exit 70
fi

GNUPGHOME="$canonical_home" "$connect_bin" --no-autostart 'GETINFO pid' /bye
echo "private_key_exposure_check=passed"
echo "completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "RESULT=PASS"
echo "Evidence retained at $trial_root"
echo "Re-run this same command with labels after-wake and after-fresh-login after those events."
