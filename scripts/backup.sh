#!/bin/sh
set -eu

script_dir=$(cd "$(dirname "$0")" && pwd)
compose() { bash "$script_dir/compose.sh" "$@"; }

# Docker names volumes "<project>_<key>", so read the project from the dev Compose file
# instead of guessing. Pass a different project name as PROJECT to back up another stack
# that uses the same volume keys, such as a CLI install (PROJECT=openteam).
project=${PROJECT:-$(sed -n 's/^name:[[:space:]]*//p' "$script_dir/../docker-compose.yml" | head -n 1)}
[ -n "$project" ] || { echo "Could not read the Compose project name from docker-compose.yml" >&2; exit 1; }

destination=${1:-"./backups/$(date -u +%Y%m%dT%H%M%SZ)"}
mkdir -p "$destination"
destination=$(cd "$destination" && pwd)

compose exec -T postgres pg_dump -U openteam -d openteam --format=custom >"$destination/postgres.dump"

# PostgreSQL is covered by the dump above; archive every other volume in the file.
volumes=$(compose config --volumes | grep -v '_postgres$')
for key in $volumes; do
  volume="${project}_${key}"
  docker volume inspect "$volume" >/dev/null 2>&1 || { echo "Volume $volume does not exist" >&2; exit 1; }
  docker run --rm \
    -v "$volume:/source:ro" \
    -v "$destination:/backup" \
    alpine:3.22 \
    tar -czf "/backup/$key.tar.gz" -C /source .
done

cat >"$destination/manifest.txt" <<MANIFEST
OpenTeam backup
Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Compose project: $project
Files: postgres.dump, $(for key in $volumes; do printf '%s.tar.gz ' "$key"; done)
MANIFEST

echo "Backup written to $destination"
