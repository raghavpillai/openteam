#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
executable="$(bash "$script_dir/ensure-cli.sh" --check)"

# The CLI uses the first existing config folder below and refuses one owned by
# another user. OpenTeam's unprivileged tool runner may find ~/.config/op owned
# by the desktop user, so use a private folder instead.
if [[ -z "${OP_CONFIG_DIR:-}" ]]; then
  private="${TMPDIR:-/tmp}/openteam-op-$(id -u)"
  found=""
  for candidate in "$HOME/.op" ${XDG_CONFIG_HOME:+"$XDG_CONFIG_HOME/op"} "$HOME/.config/op"; do
    if [[ -e "$candidate" ]]; then
      found="$candidate"
      break
    fi
  done
  if [[ -n "$found" ]]; then
    [[ -O "$found" ]] || export OP_CONFIG_DIR="$private"
  else
    parent="${XDG_CONFIG_HOME:-$HOME/.config}"
    [[ -d "$parent" && -w "$parent" ]] || export OP_CONFIG_DIR="$private"
  fi
fi
exec "$executable" "$@"
