#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir=$(CDPATH= cd -- "$script_dir/../skill/sesh-integrator-workflow" && pwd)
target_dir=${1:-"${HOME}/.agents/skills/sesh-integrator-workflow"}

mkdir -p "$target_dir/agents"
cp "$source_dir/SKILL.md" "$target_dir/SKILL.md"
cp "$source_dir/agents/openai.yaml" "$target_dir/agents/openai.yaml"

printf '%s\n' "Installed sesh-integrator-workflow at $target_dir"

# Refresh the previous installed skill too, without deleting customized resources.
# Keep its invocation name compatible with existing conversations.
legacy_dir="${HOME}/.agents/skills/parallel-integrator-workflow"
if [ "$#" -eq 0 ] && [ -d "$legacy_dir" ]; then
  sed 's/sesh-integrator-workflow/parallel-integrator-workflow/g' "$source_dir/SKILL.md" > "$legacy_dir/SKILL.md"
  mkdir -p "$legacy_dir/agents"
  sed 's/sesh-integrator-workflow/parallel-integrator-workflow/g' "$source_dir/agents/openai.yaml" > "$legacy_dir/agents/openai.yaml"
fi
