# How hosting works

OpenTeam is self-hosted. You run the server on a machine you control, and the apps connect to it. This page explains what runs where, so you can pick a good host.

## The server

The server stores your bots, conversations, files, and settings. It runs tasks and routines, and it's what the desktop and iPhone apps connect to.

Install it on any machine that can run Docker: your laptop, a desktop that stays on, a home server, or a cloud VM. Bots only work while the server is running, so a laptop that sleeps pauses your bots too. Use an always-on machine if you want routines to run overnight or while you're away.

## The bot computer

Bots work in a Linux environment on the server, with a browser, a terminal, and a filesystem. Each bot has its own screen, so several bots can use their browsers at once. They share the `/workspace` folder and website sign-ins, so one bot can pick up another's files and you only sign in to a site once.

This environment is separate from your own computer. Bots can't see your desktop or home folder unless you connect them through the desktop app. See [computer and browser](../usage/computer.md).

## What Docker runs

OpenTeam runs as a set of Docker containers, so you don't need to install its dependencies yourself.

| Container | What it does |
| --- | --- |
| Server | Sign-in, chat, settings, and app connections |
| Worker | Runs queued tasks and routines |
| Computer | The bots' Linux environment |
| PostgreSQL | The database |

If you choose public HTTPS during setup, a small proxy also runs to manage the certificate.

## What needs to stay running

- **The host and Docker** must stay on for bots to work and routines to run.
- **The desktop app** only needs to stay open while a bot uses something on [your own computer](../usage/computer.md#use-your-own-computer), such as local files or saved logins. Everything else runs on the server, so you can close the app and check back later.

Closing an app doesn't delete anything, and restarting the server keeps all your data. To move to a new machine, [back up](../manage/backups.md) first.
