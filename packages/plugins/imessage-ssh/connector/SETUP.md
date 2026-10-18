# Connect your Mac

**Before you start:** ask your OpenTeam administrator to enable this integration
and verify SSH access to your Mac without a password prompt.

Assume the target Mac has no OpenTeam installation. OpenTeam runs on the
deployment host; the Mac needs no OpenTeam app, CLI, service or account sign-in.
The bridge installs and updates a standalone Python Messages helper over SSH.
Marketplace setup takes place in your existing OpenTeam session, not on the Mac.

1. On your Mac, enable **Remote Login** and allow the SSH user to read Messages history.
2. In **Marketplace → iMessage (SSH) → account settings**, enter your **Mac SSH address**,
   such as `alex@100.64.0.10`. Use your Mac login username, not your Apple Account
   email. A hostname also works. Do not include `ssh`.
3. Choose **Connect**. OpenTeam installs a read-only helper and checks Messages
   access. Once connected, ask your agent what's new or to find a conversation.

Keep the Mac online and Messages signed in for new messages to sync. This
integration reads synced iMessage, SMS and RCS history, shows Contacts names, and
can open attachments that are downloaded to the Mac. Text replies can be enabled
separately by the administrator as described below.

If Connect fails, ask your administrator to check SSH access and Messages
permissions using the troubleshooting section below.

## Deployment internals — for the host administrator or deployment agent

The path is **agent tool → computer's packaged stdio connector → internal host
bridge → SSH → Mac reader**. The computer uses OpenTeam's existing MCP runtime.
SSH keys stay on the host. The internal bridge token is provisioned automatically
outside the plugin and Marketplace account; users never enter it.

On a Linux Docker/systemd deployment, run this once as the host user whose SSH
access should be used, from the package's connector directory:

```sh
python3 install-host.py --computer-container openteam-computer-1
```

This installs/updates the host service, generates an internal token, discovers
the computer's Docker bridge address, and writes the internal connection into
the computer's persistent home with mode 0600. The listener binds only to that
private bridge interface. The host user needs Docker access, a systemd user
session, and lingering enabled for service persistence after logout. If needed,
an administrator enables lingering with `loginctl enable-linger USER`.
No server/container rebuild is required. Re-run provisioning if Docker networking
changes or the computer's persistent home is replaced. Once installed, `openteam update`
refreshes this host service from the release it installs, then reconnects the plugin.

This provisioning script is included with the plugin; it is **not yet wired into
the general OpenTeam deployment installer**. A new deployment needs this one-time
host provisioning before the single-field Marketplace flow works. Existing
`~/.config/openteam-imessage/config.json` restricted connections migrate automatically.

The Mac needs Python 3 at `/usr/bin/python3` and a readable
`~/Library/Messages/chat.db` for the SSH user. Existing downloaded history can
be read while signed out; fresh iMessage/SMS/RCS history requires syncing.
Contacts names come from `~/Library/Application Support/AddressBook`, which the
same Full Disk Access covers; without it, handles appear without names. Attachments
are read only through their message from `~/Library/Messages`, capped at 50 MB, with
HEIC, HEIF and TIFF images converted to JPEG by `/usr/bin/sips`; the computer's
connector saves them under `/workspace/shared/imessage-attachments`.
macOS permissions or Apple Account sign-in may require the user on the Mac.

After the host's bridge files are updated, the bridge checks each Mac's reader on
first use and reinstalls an older one through the host's existing SSH access, as
on the first connection. Older bridges sharing the same Mac keep working.

For a new Mac, first establish and verify the host user's normal SSH connection.
Do not disable host-key checking or automatically trust `ssh-keyscan` output.
The bridge creates one restricted key per `user@host` and installs the reader
using the host's existing authorized connection. Only validated destinations
and fixed packaged operations are accepted; no arbitrary command/SQL tool exists.

## Troubleshooting

- Connection fails before tools appear: check the host service, private network,
  and `/home/box/.config/openteam/imessage-bridge.json` in the computer.
- `ssh_setup_required`: verify the host user's passwordless SSH and known_hosts,
  Python 3 on the Mac, and Messages database permissions.
- `ssh_unavailable`: check Mac availability, pinned host key, and restricted key.
- `messages_unavailable`: check the Mac SSH user's disk access and local database.
- `helper_outdated`: the bridge could not reinstall an older Mac reader; check the
  host user's normal SSH access to the Mac, then restart `openteam-imessage.service`.
- `IMessageStatus` returns a `notice`: nothing has reached the Mac for a day. Check
  that Messages on the Mac is signed in to iMessage and that the iPhone forwards
  SMS to it (Settings > Apps > Messages > Text Message Forwarding).

Use `IMessageStatus`, then `IMessageActivity` and `ChatItems` to validate, or run
`probe.py --endpoint ... --token-file ... --target user@host` for a content-free
end-to-end check.
Use counts when reporting diagnostics; do not print private message contents.

### Diagnose through the deployment host and SSH

Use `IMessageStatus` for history and sync health, then `IMessageSendStatus` for
Automation and, optionally, an exact chat GUID. Both use the configured restricted
SSH connection. The desktop `CheckIMessagePermissions` tool checks a different
integration and may target a different Mac.

If the tools cannot reach the bridge, inspect its service on the deployment host:

```sh
systemctl --user is-active openteam-imessage
journalctl --user -u openteam-imessage --since '5 minutes ago' --no-pager -n 40
```

For Mac-side diagnosis, connect from that host using its existing authorized SSH
access to the configured Mac, keeping host-key verification enabled. In that SSH
session, these checks identify the Mac, confirm Messages is running, and inspect
the specific consent-timeout failure without reading message bodies:

```sh
hostname
sw_vers
pgrep -x Messages
/usr/bin/log show --last 5m --style compact --predicate 'process == "tccd" AND eventMessage CONTAINS[c] "prompt timed out"'
```

Logs can expose local identifiers; summarize relevant errors rather than dumping
them into chat. Do not display bridge tokens or private key material. Routine
diagnosis does not require the OpenTeam desktop app or a test message. Initial
OS consent still requires the user to accept the prompt on the Mac's desktop;
originate that request through SSH so the grant belongs to the SSH sender.

To remove host infrastructure, stop/disable `openteam-imessage.service`, remove
its unit and `~/.local/share/openteam-imessage`, and remove the private host config
and computer bridge config. Revoke only this integration's restricted public-key
entries from the Mac's authorized_keys; preserve all other keys. Remove the Mac
reader only when no remaining integration uses it.


## Optional sending over SSH

Reading and sending can both use the same SSH bridge. Sending invokes the Mac's
Messages scripting interface; it does not require OpenTeam's desktop app. macOS
must authorize the SSH process to control Messages, and Messages must respond to
Apple events. Full Disk Access for history does not grant Automation permission.

After updating the host bridge, an administrator can explicitly enable one Mac:

```sh
python3 ~/.local/share/openteam-imessage/bridge.py \
  --root ~/.config/openteam-imessage --enable-send yourname@your-mac
systemctl --user restart openteam-imessage
```

This creates a separate dedicated key whose forced helper command includes
`--allow-send`. Existing read-only keys keep their restrictions. The host profile
must also have `allow_send: true`. A normal connection or automatic helper upgrade
never enables sending. Reconnect the Marketplace connection to discover
`IMessageSendStatus` and `SendIMessageSSH`.

Run `IMessageSendStatus` (optionally with an existing chatGuid) before sending.
`automation_denied` means macOS denied control; `automation_timeout` means the
native call timed out and permission is unknown. An off Automation switch that
will not persist is an OS permission problem, not a passwordless SSH failure.
The integration cannot override it. No message is sent by status or probe tools.

Only text replies to existing, uniquely resolved conversations are supported.
Business chats retain their exact GUID and never fall back to SMS. This does not
promise support for rich business forms, buttons, attachments or starting a new
business conversation. Verify native resolution on the actual Mac.

Each send needs a UUID requestId. A private receipt ledger on the Mac reserves it
before calling Messages. Repeating the same ID and payload returns the receipt;
a different payload conflicts. Uncertain attempts never automatically resend.
Keep `~/.local/share/openteam-imessage/send-receipts.sqlite3` when upgrading; deleting
it discards duplicate protection. A submitted receipt does not confirm delivery.

To disable sending, set the target profile's `allow_send` to false, restart the
bridge and reconnect the plugin; revoke only that target's
`openteam-imessage-send` key on the Mac to remove its underlying send permission.


### Consent setup and timed-out prompts

Routine status and send calls first use Apple's non-prompting
`AEDeterminePermissionToAutomateTarget` API. If permission is absent, they return
without running AppleScript. Do not use a short-lived AppleScript probe to request
initial consent: on macOS 26, an expired prompt can leave a denial that the
Automation switch cannot clear.

For initial authorization, first have the user at the Mac or in Screen Sharing.
Then, through the host's existing normal SSH connection (not the restricted key),
run on the Mac:

```sh
/usr/bin/python3 ~/.local/share/openteam-imessage/reader.py --allow-send --authorize-messages
```

This checks Messages without sending, gives macOS consent 120 seconds, and lets
the child process run for 150 seconds. The user must accept the native Allow
prompt. Do not run this unattended. After consent succeeds, use
`IMessageSendStatus` to verify the actual restricted SSH connection.

If the permission is stuck after a prompt timeout, macOS logs may say
`AccessRequestIndirect: prompt timed out`. First check whether the user can still
accept a pending native Allow prompt, then verify readiness over SSH; that can
recover access without a reset. If no usable prompt remains, a reported recovery is Apple's
`tccutil reset AppleEvents`, then a fresh SSH consent request with the user ready.
This resets **every app's Automation grants for the user**, not just Messages.
Review that impact with the user before doing it. Do not reset Full Disk Access,
Accessibility or all privacy services. Do not edit TCC.db or disable SIP.
