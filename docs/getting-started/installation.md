# Installation

Install the OpenTeam server on the machine that will host your bots. The desktop app can run on the same machine or connect from another one.

## Requirements

| Requirement | What you need |
| --- | --- |
| Operating system | macOS, Windows, or Linux on x64 or arm64 |
| Docker | A running Docker engine with Compose 2.20 or newer |
| Memory | 8 GB recommended |
| Disk | 8 GB free recommended. Updates need at least 4 GB free. |
| Ports | `8787` for the server (you can change it), `6200–6299` for bot screens, and `80` and `443` if you use automatic HTTPS |
| AI model | A ChatGPT or Claude subscription, an API key, or a compatible endpoint. You connect it in the app after setup. |

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

The installer downloads and verifies the `openteam` command-line tool, checks Docker, and starts guided setup. If Docker is missing, it links to the download; install it and run `openteam setup`. On a Mac with Docker Desktop installed but not running, setup starts it for you. If another check fails, fix it and run `openteam setup`. You don't need Node.js or Bun. You can [read the installer](https://openteam.so/install/source) before running it.

The tool is installed to `~/.local/bin` on macOS and Linux, and the installer adds that directory to your `PATH` in your shell's startup file, such as `~/.zshrc` or `~/.bashrc`. Open a new terminal to use `openteam`. To leave your startup files unchanged, set `OPENTEAM_NO_MODIFY_PATH=1` before running the installer. On Windows, it's installed to `%LOCALAPPDATA%\OpenTeam\bin` and added to your `PATH`.

## Guided setup

Setup sets up the connection and your account:

1. **Connection.** Setup detects a private network address, or your Tailscale HTTPS address if your tailnet has HTTPS turned on. If it can't find one, it asks for the address your devices will use to reach the server.
2. **Your account.** OpenTeam has one account per server. Use it to sign in from all your devices. Pick a username of 3 to 30 letters, numbers, dashes, underscores, or dots, starting and ending with a letter or number. Signing in ignores capital letters.

Setup then shows a summary. Choose **Start OpenTeam** to download the server and start it. If a port the server needs is in use, setup takes you back to the connection step with your answers kept. When the server is ready, setup prints the server URL and username to use in the apps.

Connect a model in the app after you sign in. See [model providers](../configuration/models.md) for the options.

Run `openteam setup --advanced` to choose a different connection mode, API port, time zone, or number of tasks that run at once. See [server settings](../configuration/server.md).

To change your username or password later, see [server commands](../manage/server.md#change-your-account).

## Check the installation

```sh
openteam status
openteam doctor
```

`status` shows the server URL, version, and health of each service. `doctor` runs deeper checks.

## Where OpenTeam is installed

Configuration lives in `~/.openteam` on macOS and Linux (or `$XDG_CONFIG_HOME/openteam` if that variable is set), and `%LOCALAPPDATA%\OpenTeam` on Windows. To use a different directory, set `OPENTEAM_HOME` or pass `--dir <path>` to any command. Your bots' data is stored in Docker volumes, not in this directory. See [backups](../manage/backups.md).

To run unreleased code or contribute, see [development from source](../development/from-source.md).
