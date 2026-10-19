#!/bin/sh
set -eu

agent_dir=${OPENTEAM_PI_AGENT_DIR:-/home/box/.pi/agent}
data_root=${OPENTEAM_AGENT_DATA_CANONICAL_ROOT:-/home/box/sand-data}
data_alias=${OPENTEAM_AGENT_DATA_ROOT:-/home/box/agent-data}
agent_uid=${OPENTEAM_AGENT_UID:-1001}
agent_gid=${OPENTEAM_AGENT_GID:-1000}
restricted=${OPENTEAM_COMPUTER_RESTRICTED:-true}

case "$restricted" in
  true) ;;
  false)
    if [ "$(awk '/^NoNewPrivs:/ { print $2 }' /proc/self/status)" != 0 ]; then
      echo "computer admin mode requires no-new-privileges:false; recreate the computer container" >&2
      exit 1
    fi
    case "$agent_uid" in
      ''|*[!0-9]*) echo "invalid OPENTEAM_AGENT_UID for computer admin mode" >&2; exit 1 ;;
    esac
    if [ "$agent_uid" -le 0 ]; then
      echo "computer admin mode requires a non-root agent UID" >&2
      exit 1
    fi
    # Use the configured numeric UID, including installations that override runner.
    # The system filesystem is writable only in the opt-in admin Compose mode.
    sudo_policy=$(mktemp /etc/sudoers.d/.openteam-runner-XXXXXX) || {
      echo "computer admin mode requires a writable system filesystem; recreate the computer container" >&2
      exit 1
    }
    trap 'rm -f "$sudo_policy"' EXIT
    printf '#%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$agent_uid" > "$sudo_policy"
    chown 0:0 "$sudo_policy"
    chmod 0440 "$sudo_policy"
    visudo -cf "$sudo_policy" >/dev/null
    mv -f "$sudo_policy" /etc/sudoers.d/openteam-runner
    trap - EXIT
    ;;
  *)
    echo "OPENTEAM_COMPUTER_RESTRICTED must be true or false" >&2
    exit 1
    ;;
esac
export OPENTEAM_COMPUTER_RESTRICTED="$restricted"

umask 0007

mkdir -p "$agent_dir"
mkdir -p "$data_root" /workspace
# Deck working folders are made with mktemp under this directory.
mkdir -p /workspace/slides
mkdir -p /home/box/Downloads /home/box/Documents
chown "$agent_uid:$agent_gid" /home/box/Downloads /home/box/Documents
chmod 2770 /home/box/Downloads /home/box/Documents

# The runner needs ordinary package caches and LibreOffice profile storage.
# Older volumes may have these parents owned by the desktop UID with mode 0700.
# Grant traversal only on the parents; do not recursively expose .local/share
# or the supervisor-owned credential directories.
for runner_dir in /home/box/.local /home/box/.cache /home/box/.local/lib /home/box/.local/bin /home/box/.cache/pip /home/box/.cache/uv /home/box/.cache/fontconfig /home/box/.cache/dconf /home/box/.config /home/box/.config/libreoffice; do
  if [ -L "$runner_dir" ]; then
    echo "refusing redirected runner package directory: $runner_dir" >&2
    exit 1
  fi
done
mkdir -p /home/box/.local /home/box/.cache /home/box/.config
chgrp "$agent_gid" /home/box/.local /home/box/.cache /home/box/.config
chmod g+x /home/box/.local /home/box/.cache /home/box/.config
for runner_dir in /home/box/.local/lib /home/box/.local/bin /home/box/.cache/pip /home/box/.cache/uv /home/box/.cache/fontconfig /home/box/.cache/dconf /home/box/.config/libreoffice; do
  mkdir -p "$runner_dir"
  chown -R "$agent_uid:$agent_gid" "$runner_dir"
  chmod 2770 "$runner_dir"
done

# The inference supervisor owns Pi credentials. Agent-launched shells and GUI
# processes start as runner and share workspace, agent-data, and browser state
# through the box group. Admin mode allows runner to access these credentials
# through sudo; the file permissions are an isolation boundary only when restricted.
chown -R 0:"$agent_gid" "$agent_dir"
chmod 0700 "$agent_dir"
find "$agent_dir" -maxdepth 1 -type f \( -name 'auth.json' -o -name 'models.json' \) -exec chmod 0600 {} \;
chgrp -R "$agent_gid" /home/box "$data_root" /workspace
chmod 0770 /home/box "$data_root" /workspace
chmod -R g+rwX "$data_root" /workspace

if [ -L "$data_alias" ]; then
  current_target=$(readlink "$data_alias")
  if [ "$current_target" != "$data_root" ]; then
    rm "$data_alias"
  fi
elif [ -d "$data_alias" ]; then
  if [ -n "$(ls -A "$data_alias")" ]; then
    echo "refusing to replace non-empty agent-data directory: $data_alias" >&2
    exit 1
  fi
  rmdir "$data_alias"
elif [ -e "$data_alias" ]; then
  echo "refusing to replace non-directory agent-data path: $data_alias" >&2
  exit 1
fi

if [ ! -L "$data_alias" ]; then
  ln -s "$data_root" "$data_alias"
fi

cd /workspace

if [ "$restricted" = true ]; then
  # Also enforce the default for direct docker run users, including an image
  # that previously had admin mode enabled. No setuid binary may elevate children.
  exec setpriv --no-new-privs "$@"
fi

exec "$@"
