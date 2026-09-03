#!/usr/bin/env bash
set -euo pipefail

if ! command -v tailscale >/dev/null 2>&1; then
  echo "The Tailscale CLI is required and must be on PATH." >&2
  exit 127
fi

openteam_tailscale_ip="$(tailscale ip -4)"
if [[ ! "$openteam_tailscale_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not determine a single Tailscale IPv4 address." >&2
  exit 1
fi

export OPENTEAM_DEV_HOST="$openteam_tailscale_ip"
echo "OpenTeam remote dev URL: http://${openteam_tailscale_ip}:5173"
exec bun --filter @openteam/desktop dev
