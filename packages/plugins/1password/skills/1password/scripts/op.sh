#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
executable="$(bash "$script_dir/ensure-cli.sh" --check 2>/dev/null || bash "$script_dir/ensure-cli.sh" --install)"

# The CLI refuses a config folder owned by another user, and OpenTeam's
# unprivileged tool runner may find one owned by the desktop user. Use a private
# folder when any folder the CLI could pick is not ours, or none can be created.
if [[ -z "${OP_CONFIG_DIR:-}" ]]; then
  private="${TMPDIR:-/tmp}/openteam-op-$(id -u)"
  found=""
  for candidate in "$HOME/.op" ${XDG_CONFIG_HOME:+"$XDG_CONFIG_HOME/.op"} "$HOME/.config/op" ${XDG_CONFIG_HOME:+"$XDG_CONFIG_HOME/op"}; do
    if [[ -e "$candidate" ]]; then
      found=1
      [[ -O "$candidate" ]] || export OP_CONFIG_DIR="$private"
    fi
  done
  if [[ -z "$found" ]]; then
    parent="${XDG_CONFIG_HOME:-$HOME/.config}"
    [[ -d "$parent" && -w "$parent" ]] || export OP_CONFIG_DIR="$private"
  fi
fi
exec "$executable" "$@"
