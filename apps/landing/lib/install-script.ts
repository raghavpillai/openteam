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

say "OpenTeam · $platform $architecture"

command_exists docker || fail "Docker is required. Install Docker, then run this command again."
if docker compose version >/dev/null 2>&1; then
  :
elif command_exists docker-compose && docker-compose version >/dev/null 2>&1; then
  :
else
  fail "Docker Compose 2.20 or newer is required."
fi
command_exists curl || fail "curl is required to download the OpenTeam CLI."

repository=$(printenv OPENTEAM_REPOSITORY 2>/dev/null || printf raghavpillai/openteam)
cli_version=$(printenv OPENTEAM_VERSION 2>/dev/null || printf latest)
if [ "$cli_version" = "latest" ]; then
  release_json=$(curl -fsSL "https://api.github.com/repos/$repository/releases/latest") ||
    fail "no public OpenTeam release is available yet."
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

say "Downloading OpenTeam $release_tag from GitHub…"
# Prefer the gzip copy (about a third of the size); fall back to the raw binary for releases
# that predate it. The checksum below is always verified against the decompressed binary.
if command_exists gunzip && curl -fsL --retry 3 --connect-timeout 15 "$release_base/$asset_name.gz" -o "$binary_path.gz" 2>/dev/null; then
  gunzip -f "$binary_path.gz" || fail "could not decompress $asset_name.gz."
else
  rm -f "$binary_path.gz"
  curl -fL --retry 3 --connect-timeout 15 "$release_base/$asset_name" -o "$binary_path" ||
    fail "could not download $asset_name from $release_tag."
fi
curl -fL --retry 3 --connect-timeout 15 "$release_base/SHA256SUMS" -o "$checksums_path" ||
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

case ":$PATH:" in
  *":$bin_directory:"*) ;;
  *) say "Note: add $bin_directory to PATH to run openteam later." ;;
esac

say "Starting the guided server setup…"
if [ -r /dev/tty ]; then
  "$installed_binary" install "$@" </dev/tty
  exit $?
fi

fail "no interactive terminal was detected. Run this installer from a terminal."
`;

export const powerShellInstallScript = String.raw`$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  Write-Error "OpenTeam installer: $Message"
  exit 1
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail "Docker is required. Install Docker Desktop, then run this command again."
}

$composeAvailable = $false
try {
  docker compose version | Out-Null
  $composeAvailable = $LASTEXITCODE -eq 0
} catch {}
if (-not $composeAvailable -and (Get-Command docker-compose -ErrorAction SilentlyContinue)) {
  try {
    docker-compose version | Out-Null
    $composeAvailable = $LASTEXITCODE -eq 0
  } catch {}
}
if (-not $composeAvailable) { Fail "Docker Compose 2.20 or newer is required." }

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

try {
  Write-Host "Downloading OpenTeam $releaseTag from GitHub..."
  # Prefer the gzip copy; fall back to the raw binary for releases that predate it.
  $compressedPath = "$binaryPath.gz"
  try {
    Invoke-WebRequest "$releaseBase/$assetName.gz" -OutFile $compressedPath
    $compressedStream = [System.IO.File]::OpenRead($compressedPath)
    $binaryStream = [System.IO.File]::Create($binaryPath)
    $gzipStream = New-Object System.IO.Compression.GZipStream($compressedStream, [System.IO.Compression.CompressionMode]::Decompress)
    $gzipStream.CopyTo($binaryStream)
    $gzipStream.Dispose(); $binaryStream.Dispose(); $compressedStream.Dispose()
  } catch {
    Invoke-WebRequest "$releaseBase/$assetName" -OutFile $binaryPath
  }
  Invoke-WebRequest "$releaseBase/SHA256SUMS" -OutFile $checksumsPath
  $checksumLine = Get-Content $checksumsPath | Where-Object { $_ -match "(^|/)$([regex]::Escape($assetName))$" } | Select-Object -First 1
  if (-not $checksumLine) { Fail "SHA256SUMS does not contain $assetName." }
  $expectedChecksum = ($checksumLine -split "\s+")[0].ToLowerInvariant()
  $actualChecksum = (Get-FileHash -Algorithm SHA256 $binaryPath).Hash.ToLowerInvariant()
  if ($actualChecksum -ne $expectedChecksum) { Fail "the OpenTeam CLI checksum did not match." }
  New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
  Copy-Item -Force $binaryPath $installedBinary
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  if (-not (($userPath -split ";") -contains $binDirectory)) {
    $newPath = if ($userPath) { "$($userPath.TrimEnd(";"));$binDirectory" } else { $binDirectory }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "Added $binDirectory to your user PATH."
  }
  & $installedBinary install @args
  exit $LASTEXITCODE
} finally {
  Remove-Item -Recurse -Force $temporaryDirectory -ErrorAction SilentlyContinue
}
`;
