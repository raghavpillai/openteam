# Routines

A routine is a task that a bot or group runs on a schedule, such as a morning briefing or a weekly report. Routines can also run when something happens in another service.

## Start with a task that works

Run the task in chat first. Connect any accounts it needs and check the result. Once you're happy with it, turn it into a routine.

## Create a routine

Ask the bot in chat:

> Every Monday at 9 AM, review the issues assigned to me. Summarize new blockers and upcoming deadlines, with links, in this conversation.

Say what the result should be and any limits, such as "prepare drafts, but don't send anything."

The bot sets up the routine. To see it, choose the computer button at the top right of the conversation (for a group, select its name), and look under **Routines**.

## Edit a routine

Open a routine to change its instructions or schedule.

- **Test run** runs it once now, so you can check the result.
- **Active** turns the routine on or off. Turning it off keeps the routine but stops it from running.
- **Run history** shows each past run and whether it succeeded.

Hiding a bot from the sidebar doesn't stop its routines. Turn off **Active** instead.

## Schedules

A routine can have up to eight schedules. Choose **Add trigger** (or **Add another**) **→ On a schedule**, then pick a preset such as **Every hour**, **Weekdays**, or **Every week**, or set an **Interval**. To enter a cron expression, change the schedule's frequency to **Custom**. Routines can run at most once every five minutes.

Schedules you set in the app use your computer's time zone. When you ask a bot to create a routine, mention the time zone if it matters.

Routines run on the server, so the server must be on at the scheduled time. They don't need the app to be open, unless the routine works on your own computer.

## Run a routine when something happens

Routines can also start when an event arrives from GitHub, Slack, Linear, Sentry, PagerDuty, Microsoft Teams, or any service that sends signed webhooks. For example, a bot could triage each new GitHub issue as it's opened.

This is an advanced setup. You need:

- A public HTTPS address for your server, so the service can reach it. See [remote access](../configuration/remote-access.md).
- Credentials from the service that let OpenTeam register a webhook, such as a management token and a signing secret.

Add the subscription in **Settings → Server → Automation event subscriptions**, then ask the bot to create a routine that runs on those events. On desktop, event routines don't appear in the **Routines** list, so ask the bot when you want to see, pause, or change one. For what each service needs, see the [event subscription reference](../reference/automation-event-subscriptions.md).

## When a routine fails

Open its **Run history** to see which runs failed, then check the conversation for the bot's message about the problem. Common causes are a disconnected plugin account, an expired model sign-in, or an approval waiting in the conversation. Fix the cause, then use **Test run** to check. See [troubleshooting](../manage/troubleshooting.md).
