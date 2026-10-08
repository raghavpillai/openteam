#!/usr/bin/env bash
# Official 1Password CLI archives from https://cache.agilebits.com/dist/1P/op2/pkg/.
set -euo pipefail

version="2.40.0"
mode="${1:---check}"
if [[ $# -gt 1 || ( "$mode" != "--check" && "$mode" != "--install" ) ]]; then
  echo "Usage: bash ensure-cli.sh [--check|--install]" >&2
  exit 2
fi

# macOS installs come from 1Password's package or Homebrew; reuse an existing one.
if [[ "$(uname -s)" == Darwin ]]; then
  if executable="$(command -v op)"; then
    printf '%s\n' "$executable"
    exit 0
  fi
  echo "Install the 1Password CLI first: https://www.1password.dev/cli/get-started (or: brew install 1password-cli)." >&2
  exit 1
fi

writable_parent() {
  local candidate="$1"
  while [[ ! -d "$candidate" && "$candidate" != / ]]; do
    candidate="$(dirname "$candidate")"
  done
  [[ -w "$candidate" && -x "$candidate" ]]
}
install_dir="${OPENTEAM_OP_CLI_DIR:-$HOME/.local/share/openteam/1password-cli/$version}"
if [[ -z "${OPENTEAM_OP_CLI_DIR:-}" ]] && ! writable_parent "$install_dir"; then
  if [[ -d /workspace && -w /workspace ]]; then
    install_dir="/workspace/.local/share/openteam/1password-cli/$version"
  fi
fi
if [[ "$install_dir" != /* ]]; then
  echo "OPENTEAM_OP_CLI_DIR must be an absolute path." >&2
  exit 2
fi
executable="$install_dir/op"
if [[ -x "$executable" ]]; then
  if [[ "$("$executable" --version)" != "$version" ]]; then
    echo "Unexpected CLI version at $executable; inspect it before replacing." >&2
    exit 1
  fi
  printf '%s\n' "$executable"
  exit 0
fi
if [[ "$mode" == "--check" ]]; then
  echo "Managed 1Password CLI is missing; run setup with --install." >&2
  exit 1
fi

case "$(uname -m)" in
  aarch64|arm64) platform="linux_arm64"; checksum="0e8ac99ee93d661aa725dc24a5ef8bf344741d224064a5dfb469dc689faec86a" ;;
  x86_64) platform="linux_amd64"; checksum="74277219e8da60958c00f9aee9d2023225e98fdda8bfd2156a5d9e85e0edaab3" ;;
  *) echo "Supported hosts: Linux on ARM64 or x64, or macOS with the 1Password CLI installed." >&2; exit 2 ;;
esac
for command in curl unzip sha256sum; do
  command -v "$command" >/dev/null || { echo "Install $command first." >&2; exit 1; }
done

mkdir -p "$install_dir"
chmod 700 "$install_dir"
# Stage on the destination filesystem: the Bot computer mounts /tmp noexec.
temporary="$(mktemp -d "$install_dir/.install.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT
archive="$temporary/op.zip"
url="https://cache.agilebits.com/dist/1P/op2/pkg/v$version/op_${platform}_v$version.zip"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 120 --output "$archive" "$url"
actual_checksum="$(sha256sum "$archive")"
if [[ "${actual_checksum%% *}" != "$checksum" ]]; then
  echo "1Password CLI archive checksum mismatch; nothing installed." >&2
  exit 1
fi
unzip -q -o "$archive" op -d "$temporary"
chmod 755 "$temporary/op"
if [[ "$("$temporary/op" --version)" != "$version" ]]; then
  echo "1Password CLI version mismatch; nothing installed." >&2
  exit 1
fi
install -m 755 "$temporary/op" "$executable"
printf '%s\n' "$executable"
