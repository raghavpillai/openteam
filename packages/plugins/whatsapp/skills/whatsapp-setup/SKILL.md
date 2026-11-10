---
name: whatsapp-setup
description: Link a WhatsApp account with a QR or phone pairing code, check sync and history coverage, recover a disconnected session, or unlink the device.
---

# WhatsApp setup and recovery

Use the intended WhatsApp account's tools. Each OpenTeam account has a private linked-device session and message store on the bot computer. Connector availability means the tools are connected; it does not establish that WhatsApp is paired. Start with `connection_status`.

## Link a device

When the user asks to connect WhatsApp, call `pair_device`. Display the returned QR image and tell them to open WhatsApp → Linked devices → Link a device on their phone. Keep the linking process running while they scan. Pairing challenges authorize access to the account; show them only in this setup conversation, without uploading them to a QR website or saving them to files.

For setup from the same phone, or when scanning is inconvenient, call `pair_device` with the user's international phone number. Show the returned code and direct them to Linked devices → Link a device → Link with phone number instead. They enter the code in WhatsApp; do not ask for a password, SMS verification code, session file, or existing account token.

Repeated `pair_device` calls retrieve the current attempt. If the challenge expires, retrieve a fresh one. Do not repeatedly restart pairing or ask for another number while an attempt is active. `cancel_pairing` stops a pending attempt; it does not unlink a device that already paired.

QR images in chat are snapshots. Use `generation`, `generated_at`, and `expires_at` to avoid presenting an old challenge as current. A refreshed QR replaces the previous challenge immediately. If the host supports a live setup view, update its image when the generation changes and hide expired images. The QR beside a WhatsApp profile is for sharing contacts; linking uses the scanner under Linked devices. An immediate phone error alone does not establish a passkey requirement or network failure. Inspect `connection_status` diagnostics and the current generation before recommending recovery.

If WhatsApp says "Check your connection", check `pairing_running` and `pairing.requires_rescan`. A `qr_secret_rotated` diagnostic means WhatsApp changed the pairing secret after a scan. Retrieve `pair_device` again within the same attempt and immediately show its replacement QR for another scan. Ordinary QR rotation alone does not prove that the phone scanned it. If the replacement also fails, inspect new events before asking for further scans.

If the phone says it cannot link devices right now, call `cancel_pairing` and let the user follow any waiting period shown by WhatsApp. A phone-side restriction may not appear in native events. Wait for the user to report that linking is available again before starting another attempt. Preserve working sessions during ordinary updates and restart tests. Relink when necessary and authorized.

After the user says they approved linking, check `connection_status`. If authenticated, the connector finishes its initial sync and starts continuous sync automatically. Try `list_chats` for a known conversation. Report initial history as still arriving when appropriate; pairing success does not establish complete history. Pairing attempts run for at most ten minutes and can end sooner when the native client exhausts its retries. Check `pairing_running` while troubleshooting to confirm the authentication process is still active.

## Recover sync and inspect history

- `logged_out` or unauthenticated: retrieve a new pairing challenge after the user asks to reconnect. Revoked devices require linking again.
- Authenticated but stopped or disconnected: inspect status and use `restart_sync` for a requested recovery. Allow startup to complete before sending; the tool explicitly reports when no send was attempted because sync is not ready.
- A running process and an activity timestamp do not prove a fresh, complete archive. Inspect `local_health`, result source metadata, and `history_coverage`; do not interpret a local doctor's `connected: false` under another process's store lock as proof that background sync is offline.
- Storage-limit warning or stopped sync at a limit: explain the configured message limit and 512 MB database cap. Keep retained history; do not delete it automatically to make sync resume. The administrator can raise the message limit in account settings when that is the reached limit.
- For an explicit older-history request, inspect `history_coverage` and resolve the chat first. `backfill_history` requests a bounded batch from the primary phone, briefly pauses sync, and resumes it afterwards. Start with one request and 50 messages. The phone must be online and retain the history; a timeout or missing batch does not prove deletion. Do not loop indefinitely.
- Passkey-gated linking is currently unsupported upstream. Relay the failure and let the user inspect their Linked devices flow; do not cycle QR codes indefinitely.

## Unlink and remove

Call `logout_account` only for an explicit request to unlink the selected WhatsApp device. It stops sync and revokes the link, while retaining local messages. The user can also revoke it from WhatsApp → Linked devices. Removing or disconnecting the OpenTeam plugin alone does not revoke the device or erase local account data. Do not claim that local history was erased or silently remove it.
