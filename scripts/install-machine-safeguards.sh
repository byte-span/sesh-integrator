#!/bin/sh
set -eu

quiet=false
[ "${1:-}" = --quiet ] && quiet=true
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

"$script_dir/install-skill.sh" ${CODEX_HANDOFF_SKILL_DIR:+"$CODEX_HANDOFF_SKILL_DIR"}
node "$script_dir/sync-managed-guidance.mjs"

hooks_dir="$project_dir/.git/hooks"
mkdir -p "$hooks_dir"
ln -sfn "$script_dir/self-hosting-pre-push" "$hooks_dir/pre-push"
ln -sfn "$script_dir/self-hosting-post-merge" "$hooks_dir/post-merge"

user_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
mkdir -p "$user_dir"
node_binary=$(command -v node)
sed -e "s|@HEALTH_CHECK@|$script_dir/codex-handoff-health-check|g" -e "s|@NODE_BINARY@|$node_binary|g" "$project_dir/systemd/codex-handoff-health.service.in" > "$user_dir/codex-handoff-health.service"
cp "$project_dir/systemd/codex-handoff-health.timer" "$user_dir/codex-handoff-health.timer"
systemctl --user daemon-reload
systemctl --user enable --now codex-handoff-health.timer

$quiet || printf '%s\n' "Installed managed guidance, self-hosting hooks, and bounded doctor timer."
