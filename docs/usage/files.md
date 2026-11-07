# Files and results

Give bots files to work from, and get back files you can open and use.

## Attach a file

Use the attachment button in the message box to add up to **20 attachments** to one message. Files and images can be up to 25 MiB each; videos can be up to 200 MiB each.

On iPhone or iPad, tap **+** and choose **Camera**, **Photos**, or **Files**. The photo tray lets you select photos and videos, then add your selection; **All Photos** opens the full library when nothing is selected. Its back control returns to the attachment menu. The photo and camera panels stay aligned with the chat when you rotate the device or resize the sidebar. Review the attachments in the message box and remove any you don't want before sending.

After you send on iPhone or iPad, pending attachments appear in the outgoing message while they upload. Supported images and videos use local thumbnails; other files show a file preview. The pending message stays in the conversation until delivery is confirmed or you discard it. See [message delivery status](conversations.md#if-a-message-doesnt-send) if it fails or remains unconfirmed.

The bot receives each attachment's filename and size, so you can refer to files by name. Large image collections may exceed what the model can see at once; the bot can still open the remaining attachments as files.

Say which file to use and what you want back:

> Use the attached CSV to summarize monthly spending by category. Attach the summary and a CSV of any rows you couldn't categorize.

For scanned documents or unusual formats, ask the bot to confirm what it could read before you rely on its analysis.

## Get a file back

Ask for a specific format, such as Markdown or CSV, and ask the bot to attach it in the chat. A file path in a message isn't the same as an attachment you can open.

Select an attachment to preview it (most common file types can be previewed), or download it to open it in another app.

## The shared workspace

Each bot works in a Linux environment with a `/workspace` folder. Files there stay between tasks and restarts, and every bot can read and write them. That makes the workspace the place for bots to share work in progress.

Keep one folder per project, with clear filenames:

```text
/workspace/launch/
  source-notes.md
  draft-brief.md
  final-brief.md
```

`/workspace` is on your server, not on your own computer. To give a bot a file from your computer, attach it, share it through a connected service such as Google Drive, or use the [local computer connection](computer.md#use-your-own-computer).

## Keep what matters

Download important results, or include the workspace in your [server backups](../manage/backups.md). Restarting or updating the server keeps workspace files.
