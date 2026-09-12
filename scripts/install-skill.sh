#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir=$(CDPATH= cd -- "$script_dir/../skill/parallel-integrator-workflow" && pwd)
target_dir=${1:-"${HOME}/.agents/skills/parallel-integrator-workflow"}

mkdir -p "$target_dir/agents"
cp "$source_dir/SKILL.md" "$target_dir/SKILL.md"
cp "$source_dir/agents/openai.yaml" "$target_dir/agents/openai.yaml"

printf '%s\n' "Installed parallel-integrator-workflow at $target_dir"
