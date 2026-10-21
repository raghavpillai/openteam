# Email

Gives Bots a mailbox over standard IMAP and SMTP, and lets routines run when new mail arrives. It needs no OpenTeam-hosted service: the Bot computer signs in to the mailbox provider directly.

## Accounts

Each account is one mailbox: an email address and an app password. Servers are detected from the address (known providers, then the domain's MX records, then Thunderbird's provider database), or entered as `host:port`, `imap://host:port` or `smtp://host:port`.

| Provider | Works | Notes |
| --- | --- | --- |
| Gmail, Google Workspace | Yes | Turn on 2-Step Verification and create an app password. Workspace administrators can block app passwords. |
| iCloud Mail (including custom domains) | Yes | App-specific password. Custom-domain addresses sign in with the iCloud username. |
| Fastmail, Yahoo, AOL, Zoho (paid), Purelymail | Yes | App password where the provider requires one. |
| Your own server (Stalwart, Dovecot, mailcow, ...) | Yes | Enter the servers. |
| Proton Mail | With Bridge | Proton Mail Bridge (paid plans) exposes local IMAP/SMTP. |
| Outlook.com, Microsoft 365 | No | Microsoft allows only OAuth for mail. |

A dedicated mailbox for the Bot keeps personal mail out of its reach.

## Routines

The connector declares an event poll (`poll_new_mail`, every 60 seconds). OpenTeam calls it for each connected account and runs every routine whose trigger matches:

```json
{ "type": "email", "inbox": "bot@example.com", "from": ["me@example.com"], "requireAuthPass": true }
```

Only mail that arrives after the account is connected fires. The routine wake contains the headers, the `message_id` and the `thread_id`; the Bot reads the conversation with ReadEmailThread. `requireAuthPass` (default true) requires the receiving server's DMARC pass, or an aligned DKIM signature when the domain publishes no DMARC policy.

## Tools

Bots get ListEmailInboxes, SearchEmailThreads, ReadEmailThread and ReadEmailAttachment. They return plain text; `connector/test/tools.test.ts` pins their inputs.

- Thread ids are the server's thread ID (Gmail and RFC 8474 servers) or the first message's `message_id`. Message ids are `INBOX:<uid>`, `SENT:<uid>` or `ALL:<uid>`; attachment ids add the attachment's index.
- SearchEmailThreads covers the inbox and Sent (All Mail on Gmail). `keyword` matches the exact phrase; `hybrid` and `semantic` rank messages with every word above those with some, because a mailbox has no meaning index.
- ReadEmailAttachment returns text-like files as text (up to 32 KB) and saves other files under `/workspace/email-attachments/<address>/` (or the temporary directory) for Read or Shell.
- ReadEmailThread shows `Reply-To` when a message has one. Mail from an address in the optional **Your own addresses** setting (`OWNER_ADDRESSES`) that passes the sender check is marked `Sender: your owner`; all other inbound mail is marked external.
- Reading never marks mail read.

## Sending

Bots send only through DraftExternalMessage review cards; there is no Bot send tool. The connector declares `drafts: { platform: "email", tool: "send_reviewed_email" }`; that host-only tool verifies the card's account and replied-to message, and sends it when the user presses Send (or at once, when the user allowed the recipients for that Bot or turned its drafts off). Replies set `In-Reply-To` and `References`; sent mail is filed in the Sent folder (Gmail does this itself).

## Tests

Unit tests run with `bun test email/connector/test`. The IMAP/SMTP round trip needs a GreenMail server:

```sh
docker run -d --name greenmail -p 3025:3025 -p 3143:3143 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' \
  greenmail/standalone:2.1.3
OPENTEAM_TEST_GREENMAIL=127.0.0.1 bun test email/connector/test/greenmail.test.ts
```
