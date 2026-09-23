# Files and results

Give bots files to work from, and get back files you can open and use.

## Attach a file

Use the attachment button in the message box to add files or images. On iPhone, you can also take a photo or choose one from your library. Wait for the upload to finish, then send your request.

Say which file to use and what you want back:

> Use the attached CSV to summarize monthly spending by category. Attach the summary and a CSV of any rows you couldn't categorize.

For scanned documents or unusual formats, ask the bot to confirm what it could read before you rely on its analysis.

## Get a file back

Ask for a specific format, such as Markdown or CSV, and ask the bot to attach it in the chat. A file path in a message isn't the same as an attachment you can open.

Select an attachment to preview it, or download it to open it in another app.

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

When you ask a bot to transform a file, ask it to keep the original so you can compare the two.
