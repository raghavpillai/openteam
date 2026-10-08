#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
executable="$(bash "$script_dir/ensure-cli.sh" --check)"

# The CLI refuses a config folder owned by another user. OpenTeam's unprivileged
# tool runner may find ~/.config/op owned by the desktop user; use a private one.
if [[ -z "${OP_CONFIG_DIR:-}" ]]; then
  config="${XDG_CONFIG_HOME:-$HOME/.config}/op"
  parent="$(dirname "$config")"
  if [[ -e "$config" && ! -O "$config" ]] || [[ ! -e "$config" && ! ( -d "$parent" && -w "$parent" ) ]]; then
    export OP_CONFIG_DIR="${TMPDIR:-/tmp}/openteam-op-$(id -u)"
  fi
fi
exec "$executable" "$@"
