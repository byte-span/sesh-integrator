#!/bin/bash
# Exported copies contain a Git bundle after the payload marker.
set -euo pipefail
fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'Run this updater on macOS.'
for tool in git node pnpm; do command -v "$tool" >/dev/null || fail "Install $tool first."; done
node -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)' || fail 'Node.js 20 or newer is required.'
repo=${1:-}
if [ -z "$repo" ]; then
  for candidate in "$HOME/code/sesh-integrator" "$HOME/code/parallel-integrator" "$HOME/Developer/tools/sesh-integrator" "$HOME/Developer/tools/parallel-integrator"; do
    if [ -d "$candidate/.git" ] && [ ! -L "$candidate" ]; then
      [ -z "$repo" ] || fail 'Multiple checkouts found. Pass the intended checkout path as the first argument.'
      repo=$candidate
    fi
  done
fi
[ -n "$repo" ] || fail 'Pass the existing checkout path as the first argument.'
repo=$(cd "$repo" && pwd -P)
[ -d "$repo/.git" ] || fail 'Expected the main checkout, not a linked worktree.'
[ -z "$(git -C "$repo" status --porcelain)" ] || fail 'Checkout has local changes. Commit or otherwise preserve them before retrying.'
node - "$repo/package.json" <<'NODE'
const p=require(process.argv[2]);
if(!['parallel-integrator','sesh-integrator','codex-handoff'].includes(p.name))process.exit(1);
NODE
branch=$(git -C "$repo" symbolic-ref --quiet --short HEAD) || fail 'Check out dev before running this updater.'
[ "$branch" = dev ] || fail 'Check out dev before running this updater; main is preserved.'
[ "$(git -C "$repo" config --get core.hooksPath || true)" = '' ] || fail 'Custom core.hooksPath detected. Review hook installation manually before upgrading.'
new_repo="$(dirname "$repo")/sesh-integrator"
if [ "$repo" != "$new_repo" ] && { [ -e "$new_repo" ] || [ -L "$new_repo" ]; }; then fail "Destination already exists: $new_repo"; fi
# Validate origin before changing the checkout; keep its value out of output.
node --input-type=module - "$repo" <<'NODE'
import {execFileSync} from 'node:child_process';
const url=execFileSync('git',['-C',process.argv[2],'remote','get-url','origin'],{encoding:'utf8'}).trim();
if (!/^(https:\/\/github\.com\/|git@github\.com:)byte-span\/(parallel-integrator|sesh-integrator)(\.git)?$/.test(url)) {
  throw new Error('Unexpected origin URL; configure the renamed repository origin manually.');
}
NODE
# Decode the bundled source locally: no push, remote reset, or remote pull.
payload_line=$(awk '/^__SESH_BUNDLE_BELOW__$/ { print NR + 1; exit }' "$0")
[ -n "$payload_line" ] || fail 'Use the exported script containing the source bundle.'
upgrade_tmp=$(mktemp -d "${TMPDIR:-/tmp}/sesh-upgrade.XXXXXX")
trap 'rm -rf "$upgrade_tmp"' EXIT
tail -n +"$payload_line" "$0" | base64 -D > "$upgrade_tmp/source.bundle"
git -C "$repo" bundle verify "$upgrade_tmp/source.bundle"
git -C "$repo" -c core.hooksPath=/dev/null fetch "$upgrade_tmp/source.bundle" refs/heads/dev
git -C "$repo" merge-base --is-ancestor HEAD FETCH_HEAD || fail 'Local dev has commits outside this upgrade. Reconcile them manually; nothing was overwritten.'
# Avoid running the old Linux-only post-merge installer during the upgrade.
git -C "$repo" -c core.hooksPath=/dev/null merge --ff-only FETCH_HEAD
if [ "$repo" != "$new_repo" ]; then
  mv "$repo" "$new_repo"
  ln -s "$new_repo" "$repo"
fi
cd "$new_repo"
# Repair linked-worktree administrative paths after moving the main checkout.
git worktree repair
# Only accept known repository URL forms; never print stored remote credentials.
node --input-type=module <<'NODE'
import {execFileSync} from 'node:child_process';
const url=execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim();
if (!/^(https:\/\/github\.com\/|git@github\.com:)byte-span\/(parallel-integrator|sesh-integrator)(\.git)?$/.test(url)) {
  throw new Error('Unexpected origin URL; configure the renamed repository origin manually.');
}
execFileSync('git',['remote','set-url','origin',url.replace(/\/(parallel-integrator|sesh-integrator)(\.git)?$/, '/sesh-integrator.git')]);
NODE
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
./scripts/install-cli.sh
printf '%s\n' "Updated checkout: $new_repo" 'Installed seshx and compatibility commands. Runtime data and configured branches were preserved.'
node dist/cli.js doctor
exit 0
