#!/bin/sh
set -eu

destination=${1:-"./backups/$(date -u +%Y%m%dT%H%M%SZ)"}
mkdir -p "$destination"
destination=$(cd "$destination" && pwd)

bash "$(dirname "$0")/compose.sh" exec -T postgres pg_dump -U openteam -d openteam --format=custom >"$destination/postgres.dump"

for volume in computer_home agent_data assets workspace box_store; do
  docker run --rm \
    -v "openteam_${volume}:/source:ro" \
    -v "$destination:/backup" \
    alpine:3.22 \
    tar -czf "/backup/openteam_${volume}.tar.gz" -C /source .
done

cat >"$destination/manifest.txt" <<EOF
OpenTeam v0 backup
Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Compose project: openteam
Files: postgres.dump, openteam_computer_home.tar.gz, openteam_agent_data.tar.gz, openteam_assets.tar.gz, openteam_workspace.tar.gz, openteam_box_store.tar.gz
EOF

echo "Backup written to $destination"
