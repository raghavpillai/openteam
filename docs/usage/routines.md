# Routines

A routine is a task that a bot or group runs on a schedule, such as a morning briefing or a weekly report. Routines can also run when an email arrives.

## Start with a task that works

Run the task in chat first. Connect any accounts it needs and check the result. Once you're happy with it, turn it into a routine.

## Create a routine

Ask the bot in chat:

> Every Monday at 9 AM, review the issues assigned to me. Summarize new blockers and upcoming deadlines, with links, in this conversation.

Say what the result should be and any limits, such as "prepare drafts, but don't send anything."

The bot sets up the routine. To see it on desktop, choose the computer button at the top right of the conversation (for a group, select its name), and look under **Routines**. On iPhone and iPad, tap the conversation's name at the top and scroll to **Routines**.

You can also create one yourself:

- **Desktop:** open the bot's settings (the gear at the top of that panel) and choose **Add routine** under **Routines**. Give it a name, the instructions to follow each time, and a schedule under **When to run**. Group routines are created by asking a bot.
- **iPhone and iPad:** choose **Add routine** under **Routines** in the bot's or group's details, then fill in **Name**, **Instructions**, and **Schedule**, and choose **Save**.

## Edit a routine

Open a routine to change its name, instructions, or schedule.

On desktop:

- **Test run** runs it once now, so you can check the result.
- **Active** turns the routine on or off. Turning it off keeps the routine but stops it from running.
- **Run history** shows each past run and whether it succeeded.

On iPhone and iPad, the same controls are **Run now**, **Enabled**, and **Recent runs**. You can also swipe a routine in the full **Routines** list to pause or resume it. A routine with more than one schedule shows its schedule there but can only be changed on desktop.

## Schedules

On desktop, a routine can have up to eight schedules. Choose **Add trigger** (or **Add another**) **→ On a schedule**, then pick a preset such as **Every hour**, **Weekdays**, or **Every week**, or set an **Interval**. To enter a cron expression, change the schedule's frequency to **Custom**. On iPhone and iPad, a routine you create has one schedule, chosen from the same presets or an **Interval**. Routines can run at most once every five minutes.

Routines use your time zone, whether you set the schedule in the app or a bot creates the routine. It follows your device unless you choose one in **Settings → General → Timezone** on desktop or **Settings → More preferences → Timezone** on iPhone and iPad.

Routines run on the server, so the server must be on at the scheduled time. They don't need the app to be open, unless the routine works on your own computer.

## Run a routine when an email arrives

Connect a mailbox with the [Email plugin](../integrations/email.md) and ask a bot to watch it, for example to reply when a particular sender writes. OpenTeam checks the mailbox itself, so email routines don't need a public server address. See [have a bot answer mail](../integrations/email.md#have-a-bot-answer-mail).

On desktop, email routines don't appear in the **Routines** list, so ask the bot when you want to see, pause, or change one. On iPhone and iPad, they're listed with your other routines.

## When a routine fails

Open its **Run history** (**Recent runs** on iPhone and iPad) to see which runs failed, then check the conversation for the bot's message about the problem. Common causes are a disconnected plugin account, an expired model sign-in, or missing information in the conversation. Fix the cause, then use **Test run** (**Run now**) to check. See [troubleshooting](../manage/troubleshooting.md).
