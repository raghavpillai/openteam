# FAQ

Answers to common questions about running OpenTeam and working with bots.

## Does it keep working when I close the app?

Server-side work and schedules can continue while the server host and Docker stay running. Delegated workers and access to your physical computer also need the OpenTeam desktop app open and connected. If the host itself sleeps or shuts down, its server stops working.

## Do I need to host it myself?

Yes. Install the server on a machine you control, then connect the apps. It can be your everyday computer or a separate host. The [quickstart](../getting-started/quickstart.md) covers the default setup.

## Can several bots work at once?

Yes. Different bots can work concurrently, subject to server capacity and model-provider limits. Each bot processes its own turns in order. Bots have separate screens and browser profiles but share workspace files.

## Is a bot using my laptop's desktop?

Its default computer is a Linux environment on the server. Access to your physical computer is a separate capability provided by the desktop app and its permissions. See [computer and browser](../usage/computer.md).

## Is all my data local?

Your installation stores the application data, but the selected model provider receives task context and connected services receive tool requests. Local model endpoints are supported when compatible; other connected tools may still use external services.

## Does one model sign-in connect all my apps?

No. Model access, web-search credentials, voice transcription, and plugin accounts are configured separately. Installing a plugin also does not automatically grant every bot access to its accounts.

## Can I use different models for different bots?

The current model and reasoning selection is shared by bots on the server. Change it in **Settings → Server** or with `openteam model`. New turns use the new selection.

## Can other people have accounts on my server?

The current installation has one owner account. Desktop and mobile clients sign in with that account. Group chats bring bots together; they are not a multi-user account system.

## Do I need a plugin for every website?

No. A bot can also work through its browser. Plugins provide structured access to supported services; browser tasks may need you to sign in or complete a verification step.

## What does it cost to run?

You provide the host and model access. Model calls, search, transcription, and connected services follow the terms and usage limits of the accounts you configure. Routines and diagnostics that call a model can also consume provider usage.

## Are updates a backup?

No. The updater saves a database backup for rollback, but a full recovery also needs the other volumes and installation configuration. See [backups and restore](backups.md).
