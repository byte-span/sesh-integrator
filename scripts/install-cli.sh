#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_file="$project_dir/dist/cli.js"
target_dir=${SESH_INTEGRATOR_BIN_DIR:-${PARALLEL_INTEGRATOR_BIN_DIR:-${CODEX_HANDOFF_BIN_DIR:-"${HOME}/.local/bin"}}}
target_file="$target_dir/seshx"

if [ ! -f "$source_file" ]; then
  printf '%s\n' "Missing $source_file; run pnpm build first." >&2
  exit 1
fi

mkdir -p "$target_dir"
chmod +x "$source_file"
ln -sfn "$source_file" "$target_file"
ln -sfn "$source_file" "$target_dir/sesh-integrator"
ln -sfn "$source_file" "$target_dir/pintx"
ln -sfn "$source_file" "$target_dir/parallel-integrator"
# Older installed guidance and repository scripts can continue to invoke it.
ln -sfn "$source_file" "$target_dir/codex-handoff"

printf '%s\n' "Installed seshx at $target_file"
"$script_dir/install-machine-safeguards.sh"
