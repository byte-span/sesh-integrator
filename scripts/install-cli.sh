#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
source_file="$project_dir/dist/cli.js"
target_dir=${SESH_INTEGRATOR_BIN_DIR:-${PARALLEL_INTEGRATOR_BIN_DIR:-${CODEX_HANDOFF_BIN_DIR:-"${HOME}/.local/bin"}}}
target_file="$target_dir/seshx"

if [ ! -f "$source_file" ]; then
  printf '%s\n' "Missing $source_file; run pnpm build first." >&2
  exit 1
fi

# Check candidate compatibility before publishing any executable links. npm removal
# can bypass this; every lifecycle command also checks persisted contracts.
node "$source_file" installation-check

case "${1:-}" in
  "") ;;
  --stable)
    # Each release is independent of Git worktrees and previous releases.
    # Pin its printed CLI path for the full lifetime of a development session.
    release_root=${SESH_INTEGRATOR_RELEASE_DIR:-"${HOME}/.local/share/sesh-integrator/releases"}
    mkdir -p "$release_root"
    release_root=$(CDPATH= cd -- "$release_root" && pwd -P)
    case "$release_root/" in
      "$project_dir/"*) printf '%s\n' "Stable releases must be outside the source checkout." >&2; exit 1 ;;
    esac
    release_dir=$(mktemp -d "$release_root/release.XXXXXXXX")
    for entry in dist skill scripts systemd package.json harnesses.json GLOBAL_AGENTS_SNIPPET.md; do
      cp -R "$project_dir/$entry" "$release_dir/$entry"
    done
    source_file="$release_dir/dist/cli.js"
    ;;
  *) printf '%s\n' "Usage: install-cli.sh [--stable]" >&2; exit 1 ;;
esac

mkdir -p "$target_dir"
chmod +x "$source_file"
# Publish each alias atomically only after the complete snapshot exists. A retry
# after interruption converges; old snapshots remain usable throughout.
for command in seshx sesh-integrator pintx parallel-integrator codex-handoff; do
  temporary_link="$target_dir/.$command.$$"
  ln -s "$source_file" "$temporary_link"
  mv -f "$temporary_link" "$target_dir/$command"
done

printf '%s\n' "Installed seshx at $target_file"
printf '%s\n' "Run seshx setup to select and install harness integrations."

[ "${1:-}" != --stable ] || printf '%s\n' "Pinned coordinator: $source_file"
