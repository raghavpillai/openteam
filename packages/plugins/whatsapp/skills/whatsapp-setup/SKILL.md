---
name: whatsapp-setup
description: Check WhatsApp sync and history coverage, explain account-settings linking, recover a disconnected session, or remove the device.
---

# WhatsApp setup and recovery

Use the intended WhatsApp account's tools. Each OpenTeam account has a private linked-device session and message store on the bot computer. Connector availability means the tools are connected; it does not establish that WhatsApp is paired. Start with `connection_status`.

## Link a device

Direct the user to the intended WhatsApp account in OpenTeam settings and choose Connect. The shared account-settings view shows the live QR, updates rotations, and offers cancellation and Get new code. On the phone, use WhatsApp → Linked devices → Link a device. The profile QR scanner does not link devices. Keep WhatsApp open while approval and initial sync finish.

Linking is managed by OpenTeam. Do not invoke hidden lifecycle tools, render QR codes in chat, ask for a phone number or code, install another client, or read private state. A new code stops the old approval before starting another. Codes expire within a fixed ten-minute attempt; a temporarily missing QR can mean rotation or bootstrap is underway. Check `connection_status` without claiming that stored keys alone establish readiness.

If WhatsApp says "Check your connection", inspect public diagnostics such as `pairing_running`, `connection_state`, `pairing.requires_rescan`, and `qr_secret_rotated`. Codes refresh in account settings. An immediate phone error alone does not establish a passkey requirement or network failure. If the phone says it cannot link devices right now, direct the user to cancel in settings and follow any waiting period shown by WhatsApp. Wait for them to report that linking is available before trying again.

After approval, OpenTeam waits until continuous sync and the send delegate are ready. Initial history can still arrive afterward. Check `connection_status` and a known conversation without claiming complete history. Preserve working sessions during routine updates and restart tests.

## Recover sync and inspect history

- `logged_out` or unauthenticated: direct the user to reconnect this account in OpenTeam settings. Revoked devices require linking again.
- Authenticated but stopped or disconnected: inspect status and use `restart_sync` for a requested recovery. Allow startup to complete before sending; the tool explicitly reports when no send was attempted because sync is not ready.
- A running process and an activity timestamp do not prove a fresh, complete archive. Inspect `local_health`, result source metadata, and `history_coverage`; do not interpret a local doctor's `connected: false` under another process's store lock as proof that background sync is offline.
- Storage-limit warning or stopped sync at a limit: explain the configured message limit and 512 MB database cap. Keep retained history; do not delete it automatically to make sync resume. The administrator can raise the message limit in account settings when that is the reached limit.
- For an explicit older-history request, inspect `history_coverage` and resolve the chat first. `backfill_history` requests a bounded batch from the primary phone, briefly pauses sync, and resumes it afterwards. Start with one request and 50 messages. The phone must be online and retain the history; a timeout or missing batch does not prove deletion. Do not loop indefinitely.
- Passkey-gated linking is currently unsupported upstream. Relay the failure and let the user inspect their Linked devices flow; do not cycle QR codes indefinitely.

## Unlink and remove

For an explicit removal request, direct the user to remove the account in OpenTeam settings. OpenTeam stops the connector and deletes its managed private session and retained archive. Disconnect preserves that state for reconnection. The user can revoke the linked device from WhatsApp → Linked devices. Removing local state does not delete the primary WhatsApp account or its phone history. User-exported attachments in the configured workspace remain there.
