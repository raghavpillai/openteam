#!/usr/bin/env bash
# Official Plaid archives and hashes from plaid/homebrew-plaid-cli/Formula/plaid.rb.
set -euo pipefail

version="20260909-fcd14fe6"
mode="${1:---check}"
if [[ $# -gt 1 || ( "$mode" != "--check" && "$mode" != "--install" ) ]]; then
  echo "Usage: bash ensure-cli.sh [--check|--install]" >&2
  exit 2
fi

install_dir="${OPENTEAM_PLAID_CLI_DIR:-$HOME/.local/share/openteam/plaid-cli/$version}"
if [[ "$install_dir" != /* ]]; then
  echo "OPENTEAM_PLAID_CLI_DIR must be an absolute path." >&2
  exit 2
fi
executable="$install_dir/plaid"
if [[ -x "$executable" ]]; then
  if [[ "$("$executable" --version)" != "$version" ]]; then
    echo "Unexpected CLI version at $executable; inspect it before replacing." >&2
    exit 1
  fi
  printf '%s\n' "$executable"
  exit 0
fi
if [[ "$mode" == "--check" ]]; then
  echo "Managed Plaid CLI is missing; run setup with --install." >&2
  exit 1
fi

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) platform="darwin_arm64"; checksum="9727b091851d8c14e9cf75609132371e763681e56a7925df91d6e68889940607" ;;
  Darwin/x86_64) platform="darwin_amd64"; checksum="25fdbb6b14548b9403d7b64cf31df8f6667928b42b53b31b5f409f30632fccba" ;;
  Linux/aarch64|Linux/arm64) platform="linux_arm64"; checksum="138a15bd2aacfabd77d4a628a634a0bc3ca3b6ebcfc2b5574221e670dd3aef04" ;;
  Linux/x86_64) platform="linux_amd64"; checksum="e8e22f3777338d9dc955dfb0fd6d102e8d25d432b86c42aedab44886f0bdbf82" ;;
  *) echo "Supported hosts: macOS/Linux on ARM64 or x64." >&2; exit 2 ;;
esac
for command in curl tar; do
  command -v "$command" >/dev/null || { echo "Install $command first." >&2; exit 1; }
done
if command -v sha256sum >/dev/null; then
  hash_command=(sha256sum)
elif command -v shasum >/dev/null; then
  hash_command=(shasum -a 256)
else
  echo "Install sha256sum or shasum first." >&2
  exit 1
fi

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
archive="$temporary/plaid.tar.gz"
url="https://releases.plaid.com/plaid-cli/releases/$version/plaid-cli_${version}_${platform}.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 120 --output "$archive" "$url"
actual_checksum="$("${hash_command[@]}" "$archive")"
if [[ "${actual_checksum%% *}" != "$checksum" ]]; then
  echo "Plaid archive checksum mismatch; nothing installed." >&2
  exit 1
fi
tar -xzf "$archive" -C "$temporary" plaid
chmod 755 "$temporary/plaid"
if [[ "$("$temporary/plaid" --version)" != "$version" ]]; then
  echo "Plaid release version mismatch; nothing installed." >&2
  exit 1
fi
mkdir -p "$install_dir"
chmod 700 "$install_dir"
install -m 755 "$temporary/plaid" "$executable"
printf '%s\n' "$executable"
