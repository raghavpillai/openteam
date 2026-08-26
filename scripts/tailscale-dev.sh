#!/usr/bin/env bash
set -euo pipefail

if ! command -v tailscale >/dev/null 2>&1; then
  echo "The Tailscale CLI is required and must be on PATH." >&2
  exit 127
fi

openbot_tailscale_ip="$(tailscale ip -4)"
if [[ ! "$openbot_tailscale_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not determine a single Tailscale IPv4 address." >&2
  exit 1
fi

export OPENBOT_DEV_HOST="$openbot_tailscale_ip"
echo "OpenBot remote dev URL: http://${openbot_tailscale_ip}:5173"
exec bun --filter @openbot/desktop dev
