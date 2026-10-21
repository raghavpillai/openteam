export const installScript = String.raw`#!/bin/sh
set -eu

say() {
  printf '%s\n' "$*"
}

fail() {
  say "OpenTeam installer: $*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

cyan=""; green=""; bold=""; reset=""
if [ -t 1 ] && [ "$(printenv TERM 2>/dev/null || printf dumb)" != "dumb" ] && ! printenv NO_COLOR >/dev/null 2>&1; then
  cyan=$(printf '\033[36m'); green=$(printf '\033[32m')
  bold=$(printf '\033[1m'); reset=$(printf '\033[0m')
fi
step() {
  printf '  %b%s%b %s\n' "$3" "$1" "$reset" "$2"
}
# ASCII source keeps raw-template bundlers from turning glyphs into literal Unicode escapes.
diamond=$(printf '\342\227\207'); checkmark=$(printf '\342\234\223')
ellipsis=$(printf '\342\200\246'); middot=$(printf '\302\267')

os_name=$(uname -s 2>/dev/null || printf unknown)
arch_name=$(uname -m 2>/dev/null || printf unknown)

case "$os_name" in
  Darwin) platform="macOS"; binary_os="darwin" ;;
  Linux) platform="Linux"; binary_os="linux" ;;
  *) fail "unsupported system: $os_name. Use https://openteam.so/download for other options." ;;
esac

case "$arch_name" in
  x86_64|amd64) architecture="x64" ;;
  arm64|aarch64) architecture="arm64" ;;
  *) fail "unsupported architecture: $arch_name. OpenTeam supports x64 and arm64 hosts." ;;
esac

printf '\n  %bOPENTEAM%b / install\n' "$bold$cyan" "$reset"
say "  $platform $middot $architecture"
say ""

command_exists curl || fail "curl is required to download the OpenTeam CLI."

repository=$(printenv OPENTEAM_REPOSITORY 2>/dev/null || printf raghavpillai/openteam)
cli_version=$(printenv OPENTEAM_VERSION 2>/dev/null || printf latest)
# Downloads give up when no data arrives for 20 seconds instead of waiting forever.
if [ "$cli_version" = "latest" ]; then
  release_json=$(curl -fsSL --connect-timeout 15 --speed-limit 1 --speed-time 20 "https://api.github.com/repos/$repository/releases/latest") ||
    fail "could not look up the latest OpenTeam release on GitHub. Check your internet connection and try again, or set OPENTEAM_VERSION to install a specific version."
  release_tag=$(printf '%s' "$release_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$release_tag" ] || fail "the latest GitHub release did not include a tag."
else
  case "$cli_version" in
    v*) release_tag="$cli_version" ;;
    *) release_tag="v$cli_version" ;;
  esac
fi

asset_name="openteam-$binary_os-$architecture"
release_base="https://github.com/$repository/releases/download/$release_tag"
temporary_directory=$(mktemp -d 2>/dev/null || mktemp -d -t openteam)
binary_path="$temporary_directory/$asset_name"
checksums_path="$temporary_directory/SHA256SUMS"

cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

step "$diamond" "Downloading CLI $release_tag$ellipsis" "$cyan"
# The gzip copy is about a third of the size; a host without gunzip takes the raw binary.
# The checksum below is always verified against the decompressed binary.
if command_exists gunzip; then
  curl -fsSL --retry 3 --connect-timeout 15 --speed-limit 1 --speed-time 20 "$release_base/$asset_name.gz" -o "$binary_path.gz" ||
    fail "could not download $asset_name.gz from $release_tag."
  gunzip -f "$binary_path.gz" || fail "could not decompress $asset_name.gz."
else
  curl -fsSL --retry 3 --connect-timeout 15 --speed-limit 1 --speed-time 20 "$release_base/$asset_name" -o "$binary_path" ||
    fail "could not download $asset_name from $release_tag."
fi
curl -fsSL --retry 3 --connect-timeout 15 --speed-limit 1 --speed-time 20 "$release_base/SHA256SUMS" -o "$checksums_path" ||
  fail "could not download checksums for $release_tag."

expected_checksum=$(awk -v name="$asset_name" '$2 == name || $2 ~ ("/" name "$") { print $1; exit }' "$checksums_path")
[ -n "$expected_checksum" ] || fail "SHA256SUMS does not contain $asset_name."

if command_exists sha256sum; then
  actual_checksum=$(sha256sum "$binary_path" | awk '{print $1}')
elif command_exists shasum; then
  actual_checksum=$(shasum -a 256 "$binary_path" | awk '{print $1}')
else
  fail "sha256sum or shasum is required to verify the download."
fi

[ "$actual_checksum" = "$expected_checksum" ] || fail "the OpenTeam CLI checksum did not match."
step "$checkmark" "Download verified" "$green"
chmod +x "$binary_path"

user_home=$(printenv HOME 2>/dev/null || true)
[ -n "$user_home" ] || fail "HOME is not set. Set OPENTEAM_BIN_DIR to choose where to install the CLI."
bin_directory=$(printenv OPENTEAM_BIN_DIR 2>/dev/null || printf '%s/.local/bin' "$user_home")
mkdir -p "$bin_directory"
installed_binary="$bin_directory/openteam"
if command_exists install; then
  install -m 0755 "$binary_path" "$installed_binary"
else
  cp "$binary_path" "$installed_binary"
  chmod +x "$installed_binary"
fi

step "$checkmark" "CLI installed" "$green"
say "    $installed_binary"

# Make openteam available in new terminals. OPENTEAM_NO_MODIFY_PATH=1 leaves profiles alone.
path_marker="# Added by the OpenTeam installer"
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
tilde_path() {
  awk -v home="$user_home" -v path="$1" 'BEGIN { if (index(path, home "/") == 1) print "~" substr(path, length(home) + 1); else print path }'
}
# Prints the profile when it changed; returns 1 when the profile could not be written.
add_path_line() {
  profile=$1; line=$2
  if [ -f "$profile" ] && grep -qxF "$line" "$profile" 2>/dev/null; then
    return 0
  fi
  mkdir -p "$(dirname "$profile")" 2>/dev/null || return 1
  { [ ! -s "$profile" ] || printf '\n'; printf '%s\n%s\n' "$path_marker" "$line"; } >>"$profile" 2>/dev/null || return 1
  tilde_path "$profile"
}
# Empty variables count as unset.
setting() {
  value=$(printenv "$1" 2>/dev/null || true)
  if [ -n "$value" ]; then printf '%s' "$value"; else printf '%s' "$2"; fi
}
add_to_path() {
  shell_name=$(basename "$(setting SHELL sh)")
  export_line="export PATH=$(shell_quote "$bin_directory"):\"\$PATH\""
  case "$shell_name" in
    zsh)
      zsh_directory=$(setting ZDOTDIR "$user_home")
      changed=$(add_path_line "$zsh_directory/.zshrc" "$export_line") || return 1 ;;
    bash)
      changed=$(add_path_line "$user_home/.bashrc" "$export_line") || return 1
      if [ "$binary_os" = "darwin" ]; then
        # Terminal on macOS starts login shells, which read only the first of these files.
        login_profile="$user_home/.bash_profile"
        for candidate in "$user_home/.bash_profile" "$user_home/.bash_login" "$user_home/.profile"; do
          if [ -f "$candidate" ]; then login_profile=$candidate; break; fi
        done
        login_changed=$(add_path_line "$login_profile" "$export_line") || return 1
        if [ -n "$changed" ] && [ -n "$login_changed" ]; then changed="$changed and $login_changed"
        else changed="$changed$login_changed"; fi
      fi ;;
    fish)
      fish_directory=$(setting XDG_CONFIG_HOME "$user_home/.config")
      changed=$(add_path_line "$fish_directory/fish/conf.d/openteam.fish" "fish_add_path -g $(shell_quote "$bin_directory")") || return 1 ;;
    *)
      changed=$(add_path_line "$user_home/.profile" "$export_line") || return 1 ;;
  esac
  if [ -n "$changed" ]; then
    say "  Added $(tilde_path "$bin_directory") to your PATH in $changed. Open a new terminal to use openteam."
  else
    say "  Open a new terminal to use openteam."
  fi
}
case ":$PATH:" in
  *":$bin_directory:"*) ;;
  *)
    if [ "$(printenv OPENTEAM_NO_MODIFY_PATH 2>/dev/null || true)" = "1" ] || ! add_to_path; then
      say "  Add $bin_directory to PATH to run openteam from new terminals."
    fi ;;
esac

printf '\n  %bSERVER SETUP%b\n\n' "$bold$cyan" "$reset"
# Opening /dev/tty can fail even when it is readable (for example, in CI).
if ( : </dev/tty ) 2>/dev/null; then
  "$installed_binary" install "$@" </dev/tty
  exit $?
fi

# The CLI checks prerequisites before asking for a terminal. Keep it installed
# when setup is blocked, so the user can fix Docker and resume with openteam setup.
"$installed_binary" install "$@" </dev/null
`;

export const powerShellInstallScript = String.raw`$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  Write-Error "OpenTeam installer: $Message"
  exit 1
}

$installerColor = -not [Console]::IsOutputRedirected -and -not (Test-Path Env:NO_COLOR) -and $env:TERM -ne "dumb"
function Write-Step([string]$Mark, [string]$Message, [string]$Color = "Cyan") {
  if ($installerColor) { Write-Host "  $Mark $Message" -ForegroundColor $Color }
  else { Write-Host "  $Mark $Message" }
}
Write-Host ""
Write-Step "OPENTEAM" "/ install"
Write-Host "  Windows"
Write-Host ""

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
switch ($architecture) {
  "x64" { $assetName = "openteam-windows-x64.exe" }
  "arm64" { $assetName = "openteam-windows-x64.exe" }
  default { Fail "unsupported Windows architecture: $architecture" }
}

$repository = if ($env:OPENTEAM_REPOSITORY) { $env:OPENTEAM_REPOSITORY } else { "raghavpillai/openteam" }
$requestedVersion = if ($env:OPENTEAM_VERSION) { $env:OPENTEAM_VERSION } else { "latest" }
if ($requestedVersion -eq "latest") {
  try { $releaseTag = (Invoke-RestMethod "https://api.github.com/repos/$repository/releases/latest").tag_name }
  catch { Fail "no public OpenTeam release is available yet." }
} else {
  $releaseTag = if ($requestedVersion.StartsWith("v")) { $requestedVersion } else { "v$requestedVersion" }
}

$releaseBase = "https://github.com/$repository/releases/download/$releaseTag"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("openteam-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$binaryPath = Join-Path $temporaryDirectory $assetName
$checksumsPath = Join-Path $temporaryDirectory "SHA256SUMS"
$binDirectory = if ($env:OPENTEAM_BIN_DIR) { $env:OPENTEAM_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "OpenTeam\bin" }
$installedBinary = Join-Path $binDirectory "openteam.exe"

$installerProgressPreference = $ProgressPreference
$ProgressPreference = "SilentlyContinue"
try {
  Write-Step ([char]0x25C7) "Downloading CLI $releaseTag$([char]0x2026)"
  # The gzip copy is about a third of the size.
  # Basic parsing avoids browser/HTML prompts in Windows PowerShell 5.1.
  $compressedPath = "$binaryPath.gz"
  Invoke-WebRequest "$releaseBase/$assetName.gz" -UseBasicParsing -OutFile $compressedPath
  $compressedStream = [System.IO.File]::OpenRead($compressedPath)
  $binaryStream = [System.IO.File]::Create($binaryPath)
  $gzipStream = New-Object System.IO.Compression.GZipStream($compressedStream, [System.IO.Compression.CompressionMode]::Decompress)
  $gzipStream.CopyTo($binaryStream)
  $gzipStream.Dispose(); $binaryStream.Dispose(); $compressedStream.Dispose()
  Invoke-WebRequest "$releaseBase/SHA256SUMS" -UseBasicParsing -OutFile $checksumsPath
  $checksumLine = Get-Content $checksumsPath | Where-Object {
    $fields = $_.Trim() -split "\s+", 2
    $fields.Count -eq 2 -and (($fields[1].Trim() -replace "^\*", "") -replace "^.*/", "") -ceq $assetName
  } | Select-Object -First 1
  if (-not $checksumLine) { Fail "SHA256SUMS does not contain $assetName." }
  $expectedChecksum = ($checksumLine.Trim() -split "\s+")[0].ToLowerInvariant()
  $actualChecksum = (Get-FileHash -Algorithm SHA256 $binaryPath).Hash.ToLowerInvariant()
  if ($actualChecksum -ne $expectedChecksum) { Fail "the OpenTeam CLI checksum did not match." }
  Write-Step ([char]0x2713) "Download verified" "Green"
  New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
  Copy-Item -Force $binaryPath $installedBinary
  Write-Step ([char]0x2713) "CLI installed" "Green"
  Write-Host "    $installedBinary"
  if ($env:OPENTEAM_NO_MODIFY_PATH -ne "1") {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { $userPath = "" }
    if (-not (($userPath -split ";") -contains $binDirectory)) {
      $newPath = if ($userPath) { "$($userPath.TrimEnd(";"));$binDirectory" } else { $binDirectory }
      [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
      Write-Host "  Added $binDirectory to your PATH."
    }
    # The user PATH applies to new terminals; this one needs it too.
    if (-not (($env:Path -split ";") -contains $binDirectory)) {
      $env:Path = if ($env:Path) { "$($env:Path.TrimEnd(";"));$binDirectory" } else { $binDirectory }
    }
  }
  Write-Host ""
  Write-Step "SERVER" "SETUP"
  Write-Host ""
  & $installedBinary install @args
  exit $LASTEXITCODE
} finally {
  $ProgressPreference = $installerProgressPreference
  Remove-Item -Recurse -Force $temporaryDirectory -ErrorAction SilentlyContinue
}
`;
