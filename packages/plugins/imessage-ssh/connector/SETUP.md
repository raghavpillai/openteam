# iMessage gateway setup

The path is **OpenTeam server → authenticated MCP endpoint → SSH → Mac reader**.
The gateway can run on the OpenTeam VM host, another private machine, or directly
beside the bot computer. Its host must reach the Mac; OpenTeam must reach the
gateway. No changes to OpenTeam's server or computer images are needed.

The Mac needs Messages signed in, its history downloaded, Python 3 at
`/usr/bin/python3`, and Remote Login enabled for the relevant user. Grant remote
users disk access in macOS Sharing settings if the database is denied. See
[Apple's Remote Login instructions](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac).
The Mac must stay awake and reachable for fresh reads. This package never writes
to Messages and has no send operation.

## Provision the Mac connection

On the gateway host, create a private directory and dedicated key:

```sh
mkdir -p ~/.config/openteam-imessage
chmod 700 ~/.config/openteam-imessage
ssh-keygen -t ed25519 -N '' -f ~/.config/openteam-imessage/id_ed25519 -C openteam-imessage-readonly
```

Transfer only the `.pub` file to the Mac. Run this package's installer on the Mac:

```sh
python3 connector/install-reader.py --public-key /path/to/id_ed25519.pub
```

It installs `~/.local/share/openteam-imessage/reader.py` and adds a `restrict`
authorized key with a forced command. The key cannot open a shell, forward ports,
or select another program. Existing authorized keys are preserved. Run the
installer again with the same key to update the reader.

Copy the Mac's `/etc/ssh/ssh_host_ed25519_key.pub` through a trusted channel, and
create a `known_hosts` entry on the gateway: `MAC_HOST ssh-ed25519 PUBLIC_KEY`.
For a nonstandard SSH port, use `[MAC_HOST]:PORT` as the first field. Do not trust
an unverified `ssh-keyscan` result or disable host-key checking.

## Run the gateway

Copy `gateway.py` and `reader.py` together to the gateway host. `reader.py` supplies
request validation there; all database reads still execute on the Mac.
Generate a token into a private file using your provisioning tool or secret
manager. For example, this writes one without displaying it:

```sh
python3 - <<'PY'
import os, secrets
from pathlib import Path
p = Path.home() / '.config/openteam-imessage/token'
with os.fdopen(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
    f.write(secrets.token_urlsafe(32) + '\n')
PY
```

Create a local `config.json` with your own connection values:

```json
{
  "ssh_target": "youruser@mac-private-address",
  "ssh_port": 22,
  "identity_file": "/home/youruser/.config/openteam-imessage/id_ed25519",
  "known_hosts_file": "/home/youruser/.config/openteam-imessage/known_hosts",
  "token_file": "/home/youruser/.config/openteam-imessage/token"
}
```

Start it with `python3 gateway.py --config /path/to/config.json`. By default it
binds `127.0.0.1:8799`. For Docker callers, bind specifically to a reachable
private host interface using `--bind PRIVATE_IP`; container `localhost` is not
the VM host. `host.docker.internal` requires an existing host-gateway mapping on
Linux. A private VPN address also works if the server container can reach it.
For public access, put the loopback listener behind an authenticated HTTPS
reverse proxy. Do not publish its plain HTTP port to the internet.

For persistence, run the same command under a user service manager (for example,
systemd on Linux, with user lingering enabled if it must survive logout). The gateway needs Python 3.9+ and OpenSSH; no Python packages
or additional OpenTeam daemon are required. Keep token and SSH key files mode
0600. Store real credentials outside the plugin directory so exports cannot
include them.

## Connect through Marketplace

Install **iMessage (SSH)**. Set **Gateway host and port** and **Gateway token**
in its account configuration. The default endpoint is `http://HOST:PORT/mcp`.
For HTTPS, use the account's MCP URL override. The normal token connection sends
`Authorization: Bearer …`; do not put tokens in URLs or skills.

Connect and run `imessage_status` in Test tool. Then call `imessage_chats` with
`{"limit":1}` and `imessage_history` with a returned `chat_id`. Both operations
are read-only. The plugin skill explains search pagination and body decoding
limits. Fixture tests do not prove a live connection; validate from the actual
OpenTeam server/container network.

You can repeat a live read check from the gateway host without printing personal
message content:

```sh
python3 connector/probe.py --endpoint http://PRIVATE_IP:8799/mcp --token-file ~/.config/openteam-imessage/token
```

It checks discovery, database access, a small history page, pagination and a
search for a returned message. Empty accounts may not supply enough data to
verify history or search; inspect the reported booleans rather than treating a
successful connection as proof of those operations.

## Limits and removal

One gateway config targets one Mac/account. Run separate gateway instances and
OpenTeam accounts for additional Macs. Rich text decoding is best effort; the
reader labels unavailable or lossy bodies and does not download attachments or
resolve Contacts. History pages are ordered by message ID, not a guaranteed
send-time order. Search scans 500 rows per call and can require many calls for
old history. The database is queried read-only, locally on the Mac, within a
per-request transaction; it is never mounted or copied to the cloud.

Uninstalling the Marketplace package removes its OpenTeam tools/skill. To revoke
the independent infrastructure, stop the gateway, remove its dedicated key line
from the Mac's `authorized_keys`, and delete its private config/key/token files.
Remove `~/.local/share/openteam-imessage` only when no other configured gateway
uses it. Do not remove unrelated keys or disable shared SSH access.
