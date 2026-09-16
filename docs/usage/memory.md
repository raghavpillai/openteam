# Memory

Memory helps a bot keep useful context between tasks, such as your preferences, project facts, and summaries of earlier work.

## Ask a bot to remember something

Be specific about the fact and who it is for:

> Remember that my weekly reports should lead with decisions, then blockers, then next steps. Keep each section brief.

You can also ask it to correct an outdated fact or forget something. Bots may save useful information from conversations automatically; memory is not a word-for-word copy of everything said.

## What is shared

| Memory | What it is for |
| --- | --- |
| Bot | Context for one bot, including its work across conversations |
| User | Personal context shared across bots where the conversation permits it |
| Project | Context for bots working on a particular project |

Group conversations cannot read or write global personal user memory. A bot's own memory can follow it between conversations, so a new chat does not necessarily mean it starts without prior context.

## Review or remove saved facts

On desktop, open the bot's details and its memory view. Search for a fact, delete individual entries, or clear the bot's memory using the available controls.

Removing memory does not erase chat history, copies in files, or records at a connected service. If the same information appears in several places, review those separately.

## Use memory with current sources

Ask the bot to check the source again when a fact may have changed. Saved context can be incomplete or out of date, especially for prices, schedules, and project status.

For a repeatable method, create a [skill](skills.md). For source material, keep the [file](files.md) or link available instead of expecting memory to reproduce it exactly.

## Long conversations

OpenTeam may summarize an older part of a conversation to keep the model's working context manageable. This is separate from saved memory and the chat history stored by your server.

Memory is part of your installation's persistent data. Include it in [backups](../manage/backups.md) when moving or restoring your server.
