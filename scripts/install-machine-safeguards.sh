#!/bin/sh
set -eu

quiet=false
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repository_dir=$project_dir
while [ "$#" -gt 0 ]; do
  case "$1" in
    --quiet) quiet=true; shift ;;
    --repo)
      [ "$#" -ge 2 ] || { printf '%s\n' "--repo requires a path" >&2; exit 1; }
      repository_dir=$2; shift 2 ;;
    *) printf '%s\n' "Usage: install-machine-safeguards.sh [--quiet] [--repo <checkout>]" >&2; exit 1 ;;
  esac
done
# A stable installation has no .git; install its hooks into the explicit repo.
hooks_dir=$(git -C "$repository_dir" rev-parse --path-format=absolute --git-path hooks)

if [ -n "${PARALLEL_INTEGRATOR_SKILL_DIR:-}" ]; then
  "$script_dir/install-skill.sh" "$PARALLEL_INTEGRATOR_SKILL_DIR"
fi
"$script_dir/install-skill.sh" --installed

mkdir -p "$hooks_dir"
ln -sfn "$script_dir/self-hosting-pre-push" "$hooks_dir/pre-push"
ln -sfn "$script_dir/self-hosting-post-merge" "$hooks_dir/post-merge"

if [ "$(uname -s)" = Darwin ]; then
  $quiet || printf '%s\n' "Installed managed guidance and self-hosting hooks (systemd is Linux-only)."
  exit 0
fi

user_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
mkdir -p "$user_dir"
node_binary=$(command -v node)
sed -e "s|@HEALTH_CHECK@|$script_dir/sesh-integrator-health-check|g" -e "s|@NODE_BINARY@|$node_binary|g" "$project_dir/systemd/sesh-integrator-health.service.in" > "$user_dir/sesh-integrator-health.service"
cp "$project_dir/systemd/sesh-integrator-health.timer" "$user_dir/sesh-integrator-health.timer"
systemctl --user daemon-reload
for previous in codex-handoff-health.timer parallel-integrator-health.timer; do
  if systemctl --user is-enabled --quiet "$previous"; then
    systemctl --user disable --now "$previous"
  fi
done
systemctl --user enable --now sesh-integrator-health.timer

$quiet || printf '%s\n' "Installed managed guidance, self-hosting hooks, and bounded doctor timer."
