# Memory

Bots remember useful context between tasks: your preferences, facts about your projects, and what happened in earlier work. Over time, this saves you from repeating yourself.

## How bots remember

As you work together, a bot notices facts worth keeping and saves them. You can also tell it directly:

> Remember that my weekly reports should lead with decisions, then blockers, then next steps. Keep each section brief.

Memory holds short facts, not a transcript. Your full chat history is stored separately on the server.

## Who can see a memory

| Memory | Holds | Available to |
| --- | --- | --- |
| Conversation | Details from one conversation | That conversation |
| Bot | The bot's role and what it has learned | That bot, in all its conversations |
| User | Facts about you | All your bots, in direct chats |
| Project | Facts about a shared project | Every bot working on that project |

Bots save what they pick up on their own to conversation or bot memory. To share something with all your bots, say so:

> Remember for all bots: I'm in the Pacific time zone and prefer meetings after 10 AM.

To share facts among bots working on the same thing, ask one bot to create a project, and ask the others to join it. Facts saved to the project are available to all of them.

Group chats can't read or change your user memory. This keeps personal details out of shared conversations.

## Correct or remove a memory

Ask the bot what it remembers, then tell it what to change:

> What do you remember about my reporting preferences?

> Forget that I prefer PDF reports. I now want Markdown.

Deleting a memory doesn't remove it from chat history, files, or connected services. Check those separately if the information appears there too.

## Keep facts current

Memory can go out of date, especially for prices, schedules, and project status. For anything that changes, ask the bot to check the source again instead of relying on what it remembers.

For a method you want followed every time, use a [skill](skills.md). For reference material, give the bot the [file](files.md) or link rather than expecting it to recall details.

## Long conversations

When a conversation gets very long, the bot summarizes the older part so it can keep working. This is separate from memory, and your full history stays in the chat.

Memory is stored on your server and included in your [backups](../manage/backups.md).
