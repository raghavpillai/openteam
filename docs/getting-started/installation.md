# Installation

Install OpenTeam on the machine that will host your bots. The desktop app can run on that machine or connect from another one.

## Requirements

| Requirement | What you need |
| --- | --- |
| Host | Linux, macOS, or Windows on x64 or arm64 |
| Docker | A running Linux-container engine, Docker CLI, and Compose 2.20+ |
| Memory | 8 GB recommended |
| Free disk | 8 GB recommended for installation; updates need at least 4 GB |
| Ports | The API uses `8787` by default; bot screens use `6200–6299` |
| Model access | A supported sign-in, API key, or compatible model endpoint |

On macOS and Windows, Docker Desktop provides the Linux environment. On Linux, Docker Engine and the Compose plugin are sufficient. Installing only the `docker` command does not install a running engine.

If you want work to continue while your laptop sleeps, use a separate host. See [how hosting works](../overview/architecture.md).

## Install

**macOS or Linux**

```sh
curl -fsSL https://openteam.so/install | sh
```

**Windows PowerShell**

```powershell
irm https://openteam.so/install.ps1 | iex
```

The installer downloads and verifies the native CLI, creates the server configuration, and starts guided setup. You do not need Node.js or Bun. You can [read the installer](https://openteam.so/install/source) before running it.

On macOS and Linux the CLI normally goes in `~/.local/bin`; add that directory to your shell's PATH if `openteam` is not found. Windows installs it in `%LOCALAPPDATA%\OpenTeam\bin` and adds it to your user PATH; reopen the terminal if needed.

## Owner account

Setup creates one owner account for this installation. Use it to sign in from your desktop and mobile devices. Group chats are conversations with your bots, not separate human accounts.

To change the account later, run:

```sh
openteam account update
```

The command prompts for credentials. Changing them signs out existing app sessions.

## Connect the apps

Copy the server URL from setup into the app's connection screen, then sign in. A phone or another computer needs an address it can reach; `localhost` on that device does not point to your server.

See [desktop and mobile](apps.md) for platform setup, or [remote access](../configuration/remote-access.md) to configure a private network or HTTPS address.

## Check the installation

```sh
openteam status
openteam doctor
```

`status` reports service health. `doctor` investigates setup and connection problems and sends a small request to the saved model provider, using normal provider usage.

Configuration is stored in `~/.openteam` by default. Use `OPENTEAM_HOME` or `--dir <path>` for another installation directory. For contributing or running unreleased code, use the [source setup guide](../development/from-source.md).
