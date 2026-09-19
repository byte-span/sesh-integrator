#!/usr/bin/env bash
# Presentation fixture, sourced only by VHS. No Git, app, or provider calls.
# The shell-local seshx function produces deliberately condensed sample output.
export PS1='\[\e[38;5;117m\]search $ \[\e[0m\]'
export PROMPT_COMMAND=''

workflow_header() {
  printf '\033[2J\033[H\033[?25l'
  printf '\033[1;38;5;117m  seshx\033[0m  /  parallel work, checked integration\n'
  printf '\033[38;5;245m  SCRIPTED EXAMPLE                                     target: dev\033[0m\n\n'
}

workflow_overview() {
  workflow_header
  printf '\033[1m  THREE TASKS. THREE WORKTREES.\033[0m\n\n'
  printf '\033[38;5;245m  WORKTREE          TASK                       STATE\033[0m\n'
  printf '  search            Add search                 \033[38;5;121mready\033[0m\n'
  printf '  keyboard          Keyboard shortcuts         \033[38;5;117mworking\033[0m\n'
  printf '  docs              Update guide               \033[38;5;117mworking\033[0m\n\n'
  printf '  Search is committed. The other agents keep working.\n\n'
}

seshx() {
  case "$*" in
    validate)
      printf '\n\033[38;5;121m  ✓ Source commit checked\n  ✓ Configured tests passed\033[0m\n\n'
      ;;
    'integrate --summary Add search --rollout none')
      printf '\n  Acquire repository lock\n'
      sleep 0.5
      printf '  Merge exact source commit into staging\n'
      sleep 0.5
      printf '  Validate combined work\n'
      sleep 0.5
      printf '\033[38;5;121m  ✓ Promote validated commit to dev\033[0m\n'
      printf '  Release lock and exit\n\n'
      printf '\033[1;38;5;121m  SEARCH INTEGRATED.\033[0m Other worktrees stay independent.\n\n'
      ;;
    *) printf 'Unsupported presentation command\n' >&2; return 1 ;;
  esac
}
