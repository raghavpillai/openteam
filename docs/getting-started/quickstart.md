# Quickstart

Install the server, connect the desktop app, and give your first bot a task.

## Before you start

You need:

- A 64-bit machine (x64 or arm64) running macOS, Windows, or Linux, ideally with 8 GB of RAM and 8 GB of free disk.
- Docker with Compose 2.20 or newer, running. On macOS or Windows, install and open [Docker Desktop](https://www.docker.com/products/docker-desktop/). On Linux, install Docker Engine with the Compose plugin.
- Access to an AI model: a ChatGPT or Claude subscription, or an OpenAI, Anthropic, or OpenRouter API key.

Check that Docker is ready:

```sh
docker info
docker compose version
```

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

The installer downloads the `openteam` command-line tool and the server, then opens guided setup.

## 2. Finish setup

Setup asks you to:

1. **Create your account.** Choose a username and password. You'll use them to sign in from the apps.
2. **Connect a model provider.** Choose **Codex** to sign in with ChatGPT, **Claude Code** to use a Claude subscription, or paste an API key. You can skip this and run `openteam setup` later, but bots can't work until a provider is connected.

If setup can't find a private network address, it first asks for the address your devices will use to reach the server.

When you choose **Start OpenTeam**, setup starts the server and prints your **server URL**. You'll need it in the next step. By default, the server is reachable from your local network or private VPN. To use it from anywhere, see [remote access](../configuration/remote-access.md).

## 3. Connect the desktop app

[Download the desktop app](https://openteam.so/download) and open it. Choose **Log In**, enter your server URL under **Server address**, and connect. Then sign in with the username and password you just created.

## 4. Give a bot a task

Choose **New chat** (the **+** in the sidebar), then **Create new Bot**. The bot greets you and asks what kind of work you want it to do. Reply with a small task:

> Create a checklist for moving apartments. Group it by timing, save it as a Markdown file, and attach it here.

Follow its progress in the chat. When it finishes, open the attached file.

If the bot doesn't respond, run `openteam doctor` on the server and see [troubleshooting](../manage/troubleshooting.md).

## Next steps

- [Set up your bot](first-bot.md) with a name and a job.
- [Connect a plugin](../usage/plugins.md) such as Gmail or GitHub.
- Turn on [web search](../configuration/web-search.md) for research tasks.
- Try one of the [use cases](../overview/use-cases.md).
