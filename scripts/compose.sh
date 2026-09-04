#!/usr/bin/env bash
set -euo pipefail

# The dev stack reports the current package version with "+dev" build metadata, so
# `openteam status`, /health, and the desktop About panel show which stack they are on
# while version-compatibility checks still treat it as the release it was built from.
if [[ -z "${OPENTEAM_VERSION:-}" ]]; then
  package_version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$(dirname "$0")/../apps/server/package.json" | head -n 1)
  export OPENTEAM_VERSION="${package_version:-0.0.1}+dev"
fi

if docker compose version >/dev/null 2>&1; then
  exec docker compose "$@"
fi

if command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose "$@"
fi

echo "Docker Compose is required (docker compose or docker-compose)." >&2
exit 127
