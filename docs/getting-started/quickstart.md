# Quickstart

Install the server, connect the desktop app and a model, and give your first bot a task.

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

The installer downloads the `openteam` command-line tool, adds it to your `PATH`, and opens guided setup. If Docker isn't installed, it tells you where to get it; install it, then run `openteam setup`.

## 2. Finish setup

Setup asks two things:

1. **How you'll connect.** The default is your private network. If setup can't find a private network address, it asks for the address your devices will use to reach the server.
2. **Your account.** Choose a username and password. You'll use them to sign in from the apps.

When you choose **Start OpenTeam**, setup downloads the server, starts it, and prints your **server URL** and username. You'll need them in the next step. By default, the server is reachable from your local network or private VPN. To use it from anywhere, see [remote access](../configuration/remote-access.md).

## 3. Connect the desktop app and a model

[Download the desktop app](https://openteam.so/download) and open it. Choose **Log In**, enter your server URL under **Server address**, and connect. You can leave off `http://`. Then sign in with the username and password you just created. If the server runs on the same computer, the app finds it and fills in your username.

The app then walks you through four short steps, one screen at a time:

1. **Server.** It checks that everything on your server is running and moves on by itself.
2. **AI model.** Choose **ChatGPT** or **Claude** to sign in with your plan in the browser, or paste an OpenAI, Anthropic, or OpenRouter API key. The app sends the model a short test message to make sure it works.
3. **Voice (optional).** Turn on voice notes with an OpenAI or Deepgram key, or choose **Skip**.
4. **First bot.** Pick a name, a look, and a job, then choose **Create**.

## 4. Give a bot a task

The bot greets you and asks what kind of work you want it to do. Reply with a small task:

> Create a checklist for moving apartments. Group it by timing, save it as a Markdown file, and attach it here.

Follow its progress in the chat. When it finishes, open the attached file.

To create more bots later, choose **New chat** (the **+** in the sidebar), then **Create new Bot**.

If the bot doesn't respond, run `openteam doctor` on the server and see [troubleshooting](../manage/troubleshooting.md).

## Next steps

- [Set up your bot](first-bot.md) with a name and a job.
- [Connect a plugin](../usage/plugins.md) such as Gmail or GitHub.
- Turn on [web search](../configuration/web-search.md) for research tasks.
- Try one of the [use cases](../overview/use-cases.md).
