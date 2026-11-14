# Memory

Bots remember useful context between tasks: your preferences, facts about your projects, and what happened in earlier work. Over time, this saves you from repeating yourself.

## How bots remember

As you work together, a bot notices facts worth keeping and saves them. You can also tell it directly:

> Remember that my weekly reports should lead with decisions, then blockers, then next steps. Keep each section brief.

Memory holds short facts, not a transcript. Learning from a completed turn resumes after a server restart. Later corrections and deletions take precedence over an interrupted review.

## Who can see a memory

| Memory | Holds | Available to |
| --- | --- | --- |
| Bot | The bot's role and what it has learned | That bot, in all its conversations |
| User | Facts about you | All your bots, in direct chats |

Unless you say otherwise, bots save what they learn to their own memory, which they use in all their conversations. To share something with all your bots, say so:

> Remember for all bots: I'm in the Pacific time zone and prefer meetings after 10 AM.

Group chats can't read or change your user memory. A bot's own memory is still available to it in groups, including what it learned in your direct chats. To keep something out of group chats, ask the bot to forget it.

## Correct or remove a memory

Ask the bot what it remembers, then tell it what to change:

> What do you remember about my reporting preferences?

> Forget that I prefer PDF reports. I now want Markdown.

Corrections replace the old fact atomically. The previous version stays in memory history and is excluded from normal recall, the Memories panel, and future memory prompts. Corrections also refresh cached memory in ongoing conversations and take precedence over automatic learning already in progress. A correction can move a fact between profile and journal while preserving its previous version. Ask for memory history when you want to know what was recorded before a change.

For tool integrations, call `RecallMemory` to get the active fact's id (use `editable id` when shown), then call `UpdateMemory` with `action: "replace"`, that `id`, the corrected `fact`, and its memory `type`. Use `write` for additional facts, not corrections. Two unrelated writes do not automatically supersede one another. `RecallMemory` accepts `includeHistory: true` to include explicitly labeled superseded facts. An assistant can replace only facts in its own memory or its own shard of shared user memory. When a newer peer copy represents identical shared text, recall preserves that peer's date and provenance and also exposes the caller's own editable id.

`forget` permanently deletes matching facts, including their historical copies. Deleting a memory doesn't remove it from chat history, files, or connected services. Check those separately if the information appears there too.

## Keep facts current

Memory can go out of date, especially for prices, schedules, and project status. For anything that changes, ask the bot to check the source again instead of relying on what it remembers.

For a method you want followed every time, use a [skill](skills.md). For reference material, give the bot the [file](files.md) or link rather than expecting it to recall details.

## Long conversations

When a conversation gets very long, the bot summarizes the older part so it can keep working. This is separate from memory, and your full history stays in the chat.

Memory is stored on your server and included in your [backups](../manage/backups.md).
