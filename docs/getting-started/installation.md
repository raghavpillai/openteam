# Installation

Install the OpenTeam server on the machine that will host your bots. The desktop app can run on the same machine or connect from another one.

## Requirements

| Requirement | What you need |
| --- | --- |
| Operating system | macOS, Windows, or Linux on x64 or arm64 |
| Docker | A running Docker engine with Compose 2.20 or newer |
| Memory | 8 GB recommended |
| Disk | 8 GB free recommended. Updates need at least 4 GB free. |
| Ports | `8787` for the server, and `6200–6299` for bot screens |
| AI model | A ChatGPT or Claude subscription, an API key, or a compatible endpoint |

On macOS and Windows, install and open Docker Desktop. On Linux, install Docker Engine and the Compose plugin. Installing only the `docker` command-line tool isn't enough; the engine must be running.

Bots only work while the host is on. If you want them to keep working while your laptop is closed, install on a machine that stays on. See [how hosting works](../overview/architecture.md).

## Install

**macOS or Linux**

```sh
curl -fsSL https://openteam.so/install | sh
```

**Windows PowerShell**

```powershell
irm https://openteam.so/install.ps1 | iex
```

The installer downloads the `openteam` command-line tool, verifies it, and starts guided setup. You don't need Node.js or Bun. You can [read the installer](https://openteam.so/install/source) before running it.

The tool is installed to `~/.local/bin` on macOS and Linux. If your terminal can't find `openteam`, add that directory to your `PATH`. On Windows, it's installed to `%LOCALAPPDATA%\OpenTeam\bin` and added to your `PATH`; open a new terminal if the command isn't found.

## Guided setup

Setup walks you through three things:

1. **Your account.** OpenTeam has one account per server. Use it to sign in from all your devices.
2. **A model provider.** See [model providers](../configuration/models.md) for the options. You can skip this and connect one later with `openteam setup`.
3. **Your server URL.** Setup detects a private network address, or your Tailscale HTTPS address if your tailnet has HTTPS turned on, and prints the URL to use in the apps.

Run `openteam setup --advanced` to choose a different connection mode, port, time zone, or number of tasks that run at once. See [server settings](../configuration/server.md).

To change your username or password later:

```sh
openteam account update
```

This signs out all connected apps.

## Check the installation

```sh
openteam status
openteam doctor
```

`status` shows the server URL, version, and health of each service. `doctor` runs deeper checks, including a short test request to your model provider.

## Where OpenTeam is installed

Configuration lives in `~/.openteam` on macOS and Linux (or `$XDG_CONFIG_HOME/openteam` if that variable is set), and `%LOCALAPPDATA%\OpenTeam` on Windows. To use a different directory, set `OPENTEAM_HOME` or pass `--dir <path>` to any command. Your bots' data is stored in Docker volumes, not in this directory. See [backups](../manage/backups.md).

To run unreleased code or contribute, see [development from source](../development/from-source.md).
