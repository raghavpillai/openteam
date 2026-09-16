# Routines

A routine gives a bot or group a saved task to run on a schedule or when a configured event arrives.

## Start with a task that works

Try the task in chat first. Connect the needed accounts and review the result before asking it to run repeatedly.

For example:

> Every Monday at 9 AM in America/New_York, review the issues assigned to me. Summarize new blockers and upcoming deadlines, with links, in this conversation.

Include the expected result and any limits, such as preparing drafts without sending messages.

## Create a routine

Open the bot or group's routines, choose a new routine, and enter its instructions and schedule. You can also ask a bot to create one. Desktop and mobile both provide routine controls.

Save it, check the time zone, and use **Run now** to test the saved task. Review the execution history to see whether it completed or needs attention.

## Schedules

Routines support schedule presets, intervals, and cron expressions. A routine can have up to eight schedules. The saved time zone determines when it runs; the installation time zone is the fallback.

Pause a routine with its enabled switch to stop future scheduled runs while keeping its instructions. Edit the routine when the task changes. Hiding its conversation does not pause it.

The host and Docker must stay running. Keep the desktop app connected when the task needs delegated workers or physical-computer access.

## Event triggers

External events need a configured subscription in **Settings → Server → Automation event subscriptions** and a public HTTPS callback address.

Configure the provider account and subscription, then attach the bot or group's listener. Supported providers include GitHub, Slack, Linear, Sentry, PagerDuty, Teams, and generic signed webhooks. Setup can create or update a remote webhook.

This is optional: scheduled routines do not require event subscriptions. Provider-specific operator details are in the [event subscription reference](../reference/automation-event-subscriptions.md).

## When a routine needs attention

Check its enabled state, schedule, time zone, and run history. Then check model access, plugin accounts, and pending approvals. Repeatedly retrying a failed run will not repair a disconnected account. See [troubleshooting](../manage/troubleshooting.md).
