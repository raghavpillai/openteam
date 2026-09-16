# Files and results

Give bots the source material they need and ask for a result you can open, check, and use.

## Attach a file

Use the attachment control in the composer to select a file or image. On mobile, you can also use the photo and camera options. Wait for the attachment to be ready, then send it with your request.

Tell the bot which file to use and what to produce:

> Use the attached CSV to summarize monthly spending by category. Attach the summary and a CSV of any rows you could not categorize.

For scanned documents or unfamiliar formats, ask the bot to confirm what it could read before relying on the analysis.

## Ask for a finished artifact

Specify a format such as Markdown, CSV, or a document file, and ask the bot to attach the result in chat. A path mentioned in a message is not the same as a downloadable attachment.

Supported file types can be previewed in the app. Use the download action to save an attachment locally. If a preview is unavailable, download the original and open it in the appropriate application.

## The shared workspace

Bots use `/workspace` on their Linux computer. Files there persist across tasks and ordinary restarts, and are visible to other bots.

Use a folder for each project and clear filenames:

```text
/workspace/launch/
  source-notes.md
  draft-brief.md
  final-brief.md
```

That path is on the bot computer. It does not automatically refer to a folder on your laptop. Attach local files, use a connected service, or approve a transfer through the [local computer connection](computer.md#use-your-own-computer).

## Review and retain your work

Ask for sources, assumptions, and checks alongside important results. Keep the original file when requesting transformations so you can compare it with the output.

Download important deliverables or include the workspace and attachments in your [server backups](../manage/backups.md). Updating the app or restarting a container is different from deleting the server's data volumes.
