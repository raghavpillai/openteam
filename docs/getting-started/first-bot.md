# Create and manage bots

A bot is a continuing conversation with a name, a job, and saved context. Start with one bot, then add others when you have work that benefits from different roles.

## Create a bot

Open a new chat and choose **Create new Bot**. Send a message explaining the work you want it to do:

> Help me maintain our product documentation. Keep explanations short, check claims against the source, and ask when a requirement is unclear. Start by reviewing the README I attach next.

Use the bot's settings to change its name, description, and avatar. These make it easier to recognize in your sidebar and group chats.

## Give it a clear task

Include the result you want, the relevant files or links, and any constraints. A useful request says what finished work should look like:

> Turn these meeting notes into a decision log. Include the decision, owner, and next step. Mark unknown owners instead of guessing, and attach a Markdown file.

If a task needs an account, connect the [plugin](../usage/plugins.md) and grant this bot access. Your model-provider sign-in does not connect your email, calendar, or other apps.

## Follow up and correct it

Use the same conversation for follow-up work. Tell the bot what to change and what to keep. For longer work, ask for a checkpoint before it makes consequential changes.

If you stop a running task, review anything already done; stopping does not undo file edits or changes to an external service.

## Keep bots organized

Use recognizable names such as Research, Operations, or Docs. Pin frequent conversations and hide ones you do not need in the sidebar. Hiding a conversation does not pause its routines; use the routine's enabled switch for that.

Bots use the server's selected [model and reasoning level](../configuration/models.md). Their conversations, memory, and plugin grants can differ even though that selection is shared.

## Give it another job

Use a [group chat](../usage/conversations.md) when several bots need to work together. Save a successful method as a [skill](../usage/skills.md), or turn recurring work into a [routine](../usage/routines.md).
