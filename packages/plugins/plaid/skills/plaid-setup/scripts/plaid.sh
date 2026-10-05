#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
executable="$(bash "$script_dir/ensure-cli.sh" --check)"

# OpenTeam's unprivileged tool runner may have a read-only home config folder.
# Keep one stable location across Shell jobs without changing HOME.
if [[ "$(uname -s)" == Linux && -z "${XDG_CONFIG_HOME:-}" && -d /workspace ]]; then
  candidate="$HOME/.config/plaid-cli"
  while [[ ! -d "$candidate" && "$candidate" != / ]]; do
    candidate="$(dirname "$candidate")"
  done
  if [[ ! -w "$candidate" || ! -x "$candidate" ]]; then
    export XDG_CONFIG_HOME=/workspace/.config
  fi
fi
exec "$executable" "$@"
