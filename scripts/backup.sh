#!/bin/sh
set -eu

destination=${1:-"./backups/$(date -u +%Y%m%dT%H%M%SZ)"}
mkdir -p "$destination"
destination=$(cd "$destination" && pwd)

bash "$(dirname "$0")/compose.sh" exec -T postgres pg_dump -U openbot -d openbot --format=custom >"$destination/postgres.dump"

for volume in openbot_computer_home openbot_workspace; do
  docker run --rm \
    -v "openbot_${volume}:/source:ro" \
    -v "$destination:/backup" \
    alpine:3.22 \
    tar -czf "/backup/${volume}.tar.gz" -C /source .
done

cat >"$destination/manifest.txt" <<EOF
OpenBot v0 backup
Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Compose project: openbot
Files: postgres.dump, openbot_computer_home.tar.gz, openbot_workspace.tar.gz
EOF

echo "Backup written to $destination"
