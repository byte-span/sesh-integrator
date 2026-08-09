#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
canonical_prefix="${CODEX_GPG_PREFIX:-/opt/homebrew/opt/gnupg}"
canonical_home="${CODEX_GPG_CANONICAL_HOME:-$HOME/.gnupg}"
bridge_home="${CODEX_GPG_BRIDGE_HOME:-$HOME/.codex-gpg}"
wrapper="$HOME/.local/bin/codex-gpg"
agent_runner="$HOME/.local/libexec/codex-gpg-agent"
launch_agent="$HOME/Library/LaunchAgents/com.codex.gpg-agent.plist"
gpg_bin="$canonical_prefix/bin/gpg"
gpgconf_bin="$canonical_prefix/bin/gpgconf"
connect_bin="$canonical_prefix/bin/gpg-connect-agent"
pinentry_bin="${CODEX_GPG_PINENTRY:-/opt/homebrew/bin/pinentry-mac}"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$bridge_home/backups/$timestamp"
uid=$(id -u)

for executable in "$gpg_bin" "$gpgconf_bin" "$connect_bin" "$pinentry_bin"; do
  [ -x "$executable" ] || {
    printf '%s\n' "Missing required current GnuPG component: $executable" >&2
    printf '%s\n' "Install it first with: /opt/homebrew/bin/brew install gnupg pinentry-mac" >&2
    exit 69
  }
done

version=$($gpg_bin --version | sed -n '1s/.* //p')
major=$(printf '%s' "$version" | cut -d. -f1)
minor=$(printf '%s' "$version" | cut -d. -f2)
if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 4 ]; }; then
  printf '%s\n' "Refusing obsolete GnuPG $version; install a current 2.4.x release." >&2
  exit 69
fi

mkdir -p "$backup_dir" "$HOME/.local/bin" "$HOME/.local/libexec" \
  "$HOME/Library/LaunchAgents" "$bridge_home"
chmod 700 "$bridge_home" "$bridge_home/backups" "$backup_dir" \
  "$HOME/.local/libexec"

backup_if_present() {
  source=$1
  name=$2
  if [ -e "$source" ] || [ -L "$source" ]; then
    cp -p "$source" "$backup_dir/$name"
    chmod 600 "$backup_dir/$name"
  fi
}

backup_if_present "$HOME/.gitconfig" gitconfig
backup_if_present "$canonical_home/gpg.conf" gpg.conf
backup_if_present "$canonical_home/gpg-agent.conf" gpg-agent.conf
backup_if_present "$wrapper" codex-gpg
backup_if_present "$launch_agent" com.codex.gpg-agent.plist

if [ -d "$bridge_home/private-keys-v1.d" ] &&
  find "$bridge_home/private-keys-v1.d" -mindepth 1 -print -quit | grep -q .; then
  printf '%s\n' "Refusing installation: private-key material exists under $bridge_home/private-keys-v1.d" >&2
  exit 70
fi

agent_config="$canonical_home/gpg-agent.conf"
agent_config_tmp="$backup_dir/gpg-agent.conf.updated"
if [ -f "$agent_config" ]; then
  awk '!/^pinentry-program[[:space:]]/' "$agent_config" >"$agent_config_tmp"
else
  : >"$agent_config_tmp"
fi
printf 'pinentry-program %s\n' "$pinentry_bin" >>"$agent_config_tmp"
chmod 600 "$agent_config_tmp"
mv "$agent_config_tmp" "$agent_config"
chmod 600 "$agent_config"

install -m 700 "$script_dir/codex-gpg" "$wrapper"
install -m 700 "$script_dir/codex-gpg-agent" "$agent_runner"
sed -e "s|__AGENT_RUNNER__|$agent_runner|g" \
  -e "s|__BRIDGE_HOME__|$bridge_home|g" \
  "$script_dir/com.codex.gpg-agent.plist" >"$launch_agent"
chmod 600 "$launch_agent"
plutil -lint "$launch_agent" >/dev/null

git config --global gpg.program "$wrapper"
git config --global commit.gpgSign true

# MacGPG's login helper shuts down the shared ~/.gnupg agent. Disable and
# unload only that helper; leave MacGPG applications, keys, and configs intact.
/bin/launchctl disable "gui/$uid/org.gpgtools.macgpg2.shutdown-gpg-agent" 2>/dev/null || true
/bin/launchctl bootout "gui/$uid" /Library/LaunchAgents/org.gpgtools.macgpg2.shutdown-gpg-agent.plist 2>/dev/null || true

GNUPGHOME="$canonical_home" "$gpgconf_bin" --kill gpg-agent 2>/dev/null || true
/bin/launchctl bootout "gui/$uid/com.codex.gpg-agent" 2>/dev/null || true
/bin/launchctl bootstrap "gui/$uid" "$launch_agent"
/bin/launchctl kickstart -k "gui/$uid/com.codex.gpg-agent"

attempts=0
until GNUPGHOME="$canonical_home" "$connect_bin" --no-autostart 'GETINFO pid' /bye >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 20 ]; then
    printf '%s\n' "LaunchAgent loaded but no canonical agent answered after 5 seconds." >&2
    printf '%s\n' "Inspect: launchctl print gui/$uid/com.codex.gpg-agent" >&2
    exit 70
  fi
  sleep 0.25
done

canonical_socket="$canonical_home/S.gpg-agent"
bridge_socket="$bridge_home/S.gpg-agent"
if [ -L "$bridge_socket" ]; then
  [ "$(readlink "$bridge_socket")" = "$canonical_socket" ] || {
    printf '%s\n' "$bridge_socket points to a non-canonical socket; refusing replacement." >&2
    exit 70
  }
elif [ -e "$bridge_socket" ] || [ -S "$bridge_socket" ]; then
  printf '%s\n' "$bridge_socket is not a symlink; refusing to delete a possibly competing socket." >&2
  exit 70
else
  ln -s "$canonical_socket" "$bridge_socket"
fi

printf '%s\n' "Installed canonical GnuPG reliability configuration."
printf '%s\n' "GnuPG: $version at $gpg_bin"
printf '%s\n' "Agent: gui/$uid/com.codex.gpg-agent using $canonical_home"
printf '%s\n' "Git wrapper: $wrapper"
printf '%s\n' "Configuration backup (no private keys): $backup_dir"
