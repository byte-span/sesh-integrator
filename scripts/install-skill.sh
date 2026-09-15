#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir=$(CDPATH= cd -- "$script_dir/../skill/sesh-integrator-workflow" && pwd)
harness=codex
explicit_harness=false
if [ "${1:-}" = "--harness" ]; then
  [ "$#" -eq 2 ] || { echo "Usage: $0 [target-directory | --harness codex|claude|gemini|grok]" >&2; exit 1; }
  harness=$2
  explicit_harness=true
  case "$harness" in
    codex) skill_home=.agents ;;
    claude) skill_home=.claude ;;
    gemini) skill_home=.gemini ;;
    grok) skill_home=.grok ;;
    *) echo "Unknown harness: $harness" >&2; exit 1 ;;
  esac
  target_dir="${HOME}/$skill_home/skills/sesh-integrator-workflow"
else
  [ "$#" -le 1 ] || { echo "Expected at most one target directory" >&2; exit 1; }
  case "${1:-}" in --*) echo "Unknown option: $1" >&2; exit 1 ;; esac
  target_dir=${1:-"${HOME}/.agents/skills/sesh-integrator-workflow"}
fi

mkdir -p "$target_dir"
cp "$source_dir/SKILL.md" "$target_dir/SKILL.md"
if [ "$harness" = codex ]; then
  mkdir -p "$target_dir/agents"
  cp "$source_dir/agents/openai.yaml" "$target_dir/agents/openai.yaml"
fi

printf '%s\n' "Installed sesh-integrator-workflow at $target_dir"

# Refresh the previous installed skill too, without deleting customized resources.
# Keep its invocation name compatible with existing conversations.
legacy_dir="${HOME}/.agents/skills/parallel-integrator-workflow"
if [ "$#" -eq 0 ] && [ -d "$legacy_dir" ]; then
  sed 's/sesh-integrator-workflow/parallel-integrator-workflow/g' "$source_dir/SKILL.md" > "$legacy_dir/SKILL.md"
  mkdir -p "$legacy_dir/agents"
  sed 's/sesh-integrator-workflow/parallel-integrator-workflow/g' "$source_dir/agents/openai.yaml" > "$legacy_dir/agents/openai.yaml"
fi

# An explicit harness selection installs its always-loaded global policy too.
if [ "$explicit_harness" = true ]; then
  PARALLEL_INTEGRATOR_DOCTOR_HOME="$HOME" node "$script_dir/sync-managed-guidance.mjs" --harness "$harness"
fi
