# Quickstart

Install the server, connect the desktop app, and give your first bot a task.

## Before you start

You need an x64 or arm64 machine with Docker Engine and Docker Compose 2.20 or newer. We recommend 8 GB of RAM and 8 GB of free disk space. Use a host that can stay awake while bots work.

On macOS or Windows, start Docker Desktop. On Linux, start Docker Engine. Check both the engine and Compose:

```sh
docker info
docker compose version
```

You will also need a [model provider](../configuration/models.md). You can connect one during setup.

## 1. Install the server

Run this on the machine that will host your bots.

**macOS or Linux**

```sh
curl -fsSL https://openteam.so/install | sh
```

**Windows PowerShell**

```powershell
irm https://openteam.so/install.ps1 | iex
```

The installer downloads the OpenTeam CLI and opens guided setup. Node.js and Bun are not required.

## 2. Finish guided setup

Create your owner username and password, then connect a model provider. Setup supports the available subscription sign-ins, API keys, and compatible custom endpoints. You can skip this step, but bots cannot work until a provider is connected.

Save the **server URL** printed at the end. Setup uses your private LAN or VPN by default. For other connection options, see [remote access](../configuration/remote-access.md).

## 3. Connect the app

[Download the desktop app](https://openteam.so/download), enter the server URL, and sign in with the account you just created.

Choose **Create new Bot**, then send a small task:

> Create a checklist for moving apartments. Group it by timing, save it as a Markdown file, and attach it here.

Follow its progress in chat and open the result when it finishes. Keep the desktop app connected while getting started.

## 4. Make it useful to you

Give the bot a job and a name, then try it with your own context. Read [create and manage bots](first-bot.md), [connect a plugin](../usage/plugins.md), or choose a [use case](../overview/use-cases.md).

If it does not respond, run `openteam status` and follow [troubleshooting](../manage/troubleshooting.md).
