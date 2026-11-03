# Email

Give your bots their own mailbox. With the **Email** plugin, bots can search, read and send mail, and routines can run when new mail arrives, for example "reply to anything my accountant sends" or "file receipts and tell me the total."

The plugin uses standard IMAP and SMTP, so it works with most mailbox providers. OpenTeam doesn't host mail: your server signs in to the mailbox you connect.

## Choose a mailbox

Use a mailbox just for the bot, so it never sees your personal mail. Any of these work:

| Mailbox | What you need |
| --- | --- |
| A new Gmail account | 2-Step Verification and an [app password](https://myaccount.google.com/apppasswords). |
| A Google Workspace user on your domain, such as `bot@yourcompany.com` | The same as Gmail. Your Workspace administrator must allow app passwords. |
| iCloud Mail, including custom domains | An [app-specific password](https://support.apple.com/102654). Custom-domain addresses sign in with the iCloud username. |
| Fastmail, Yahoo, AOL, Purelymail, Zoho (paid plans) | An app password if the provider requires one. |
| Your own mail server | Its IMAP and SMTP addresses. |
| Proton Mail | A paid plan and [Proton Mail Bridge](https://proton.me/mail/bridge) running where the bot computer can reach it. |

Outlook.com and Microsoft 365 can't be used: Microsoft only lets mail apps sign in with OAuth, not app passwords.

## Connect it

1. In **Marketplace**, choose **Add** on **Email**.
2. Open the plugin's account settings and enter the **Email address** and the **App password**.
3. Leave **IMAP server** and **SMTP server** set to `auto`. OpenTeam finds them from the address, including custom domains hosted by Google, iCloud or Fastmail. For your own server or Proton Mail Bridge, enter them as `host:port`, or `imap://host:port` and `smtp://host:port` for a local bridge without TLS.
4. Optionally, list the addresses you'll email the bot from under **Your own addresses**, separated by commas. Mail from them that passes the sender check (DMARC) is marked as coming from you, so the bot treats it as your request. All other mail is marked as outside information.
5. Choose **Connect**. OpenTeam signs in to check the password. A wrong password or blocked app password shows as an error on the account.

To connect more mailboxes, add another account with a new name. Every bot can use every connected mailbox.

## Have a bot answer mail

Mail never wakes a bot on its own. Ask a bot for a routine, for example:

> Watch bot@yourcompany.com. When my accountant at accountant@firm.com emails, read it and reply in the same thread.

The bot saves a routine with an email trigger:

```json
{ "type": "email", "inbox": "bot@yourcompany.com", "from": ["accountant@firm.com"] }
```

- `from` limits which senders fire the routine. It takes addresses, or `@domain` for everyone at a domain. Leave it out to accept any sender.
- By default, only mail whose sender passed DMARC (or an aligned DKIM signature) at your provider fires, so forged senders are ignored. A routine can turn this off with `"requireAuthPass": false`.
- OpenTeam checks each connected mailbox about once a minute. Only mail that arrives after you connect the account fires routines.
- Several routines, on different bots, can watch the same mailbox. Each matching routine runs once per message.

When a routine fires, the bot receives the message's headers and its conversation ID, and reads the conversation itself. Reading doesn't mark mail as read. The bot is told to treat email content as untrusted and not to reply to automated mail.

## Approve before it sends

By default, nothing leaves the mailbox until you approve it. When a bot writes an email, whether a new message or a reply from a routine while you're away, it appears in the bot's chat as a draft card titled **New email** or **Reply**, with From, In reply to, To, Cc, Subject and the message. You can edit it, then choose **Send** or **Discard**. Replies stay in the original thread. Once it's sent, the card shrinks to one line, such as "Sent to ann@example.com — “Re: Invoice”"; select it to see the full message.

The menu in the card's corner, **Needs approval**, sets how that bot's later emails are reviewed:

- **Always allow** lets the bot email this card's recipients without asking. Their next drafts send on their own, and the card says **Auto-approved by your rule**. Choose **Needs approval** on any card to these recipients to take the permission back.
- **Disable drafts for Bot** sends all of that bot's emails and Slack messages without a card. Choose **Needs approval** on any of its cards to turn review back on.

These settings belong to the bot, not to the mailbox, so other bots using the same mailbox still ask first.

## What bots can do

Bots get these email tools:

- **ListEmailInboxes** shows the inbox address.
- **SearchEmailThreads** finds conversations in the inbox and sent mail. Use exact-phrase matching for addresses and ticket numbers; otherwise results with every word rank first.
- **ReadEmailThread** reads a whole conversation, oldest first, with its attachments listed.
- **ReadEmailAttachment** returns text files such as CSV, JSON and calendar files as text, and saves other files, such as PDFs and images, to a path on the bot's computer.
- **Sending** goes through a draft card (see above); replies stay in the original thread and sent mail is filed in the Sent folder.

Reading never marks mail as read.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Could not sign in" | Use an app password, not the normal password, and check that 2-Step Verification is on. For iCloud custom domains, set **Sign-in username** to your iCloud username. |
| "Could not find the mail servers" | Enter the IMAP and SMTP servers from your provider's mail-app settings. |
| A routine didn't fire | Check that the mail is in the inbox, not spam, and arrived after the account was connected. Check the routine's `inbox` and `from`, and whether the sender passes DMARC. |
