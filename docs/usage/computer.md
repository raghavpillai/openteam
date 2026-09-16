# Computer and browser

Each bot has a Linux screen and browser profile where it can work through websites, run commands, and use files. You can watch that screen and take over when needed.

## Open a bot's screen

Open the bot's details and select its computer preview. The screen shows the bot's environment, not your personal desktop.

Use it to see a browser task in progress, check a result, or complete a step that needs you. When a site requires sign-in, enter your credentials directly in that site's login form.

## Take over and return control

Choose takeover or pause before typing or clicking on a screen the bot is using. Finish the manual step, then return control and tell the bot where to continue.

For example:

> I signed in and opened the project dashboard. Continue from this page and export the report.

A website can require another verification step, expire a login, or block automation. If that happens, complete the allowed manual step or choose another way to finish the task.

## What is shared

Each bot has its own screen and browser profile, so a login in one bot's browser is not automatically a login in another's. Files in `/workspace` are shared across bots.

Separate screens do not make bots separate security tenants. Use plugin grants and task instructions to control access, and avoid putting material in the shared workspace that other bots should not use.

## Use your own computer

Work on your physical computer goes through the OpenTeam desktop app. Keep it open and connected to the server.

In **Settings → Computer**, choose whether local execution should **Ask every time**, **Always allow**, or **Never allow**. Supported native capabilities may also need operating-system permissions. Review the requested action before granting access.

The Linux computer and the physical computer are different places. Be explicit about which one contains a file or should run a task.

## If the screen is unavailable

Check that the server and Docker are running and that the app can reach the server. For local-computer or delegation failures, also check the desktop app's connection and permissions. See [troubleshooting](../manage/troubleshooting.md).
