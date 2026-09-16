# How hosting works

OpenTeam has three parts you interact with: the server that stores your work, the computer bots work on, and the apps you use to talk to them.

## Your server

The server runs on a machine you choose: your own computer, a spare machine, or a remote Linux host. It stores conversations, schedules work, and connects the apps to your bots.

A remote host is useful when you want work to continue while your laptop is off. If you host on the laptop itself, sleeping or shutting it down also stops the server.

## The bot computer

Bots work inside a shared Linux environment with a browser, terminal, and filesystem. Each bot has its own screen and browser profile. Files under `/workspace` are shared, so two bots can work on the same project.

This environment is separate from your laptop's desktop and home folder. Access to your physical computer uses the desktop app and its permissions. See [computer and browser](../usage/computer.md).

## What Docker does

Docker runs OpenTeam's services in containers. A container is a packaged environment for a service; you do not need to install its dependencies manually.

| Service | Why it is there |
| --- | --- |
| Server | Handles sign-in, chat, settings, and app connections |
| Worker | Runs queued tasks and routines |
| Computer | Provides the Linux environment and model runtime |
| PostgreSQL | Stores application data |

Setup starts these together using Docker Compose. Public HTTPS mode also starts a small proxy to manage the certificate. Short-lived setup containers may show **Exited (0)** after installation; that means their initialization work finished successfully.

## What needs to stay running

Keep the host and Docker running for bots and routines. The desktop app also needs to stay open and connected when a task needs delegated workers or physical-computer access.

Closing a client does not delete your conversations. Restarting the containers preserves stored data, but deleting their volumes removes it. Use [backups](../manage/backups.md) before moving to another machine or Docker installation.
