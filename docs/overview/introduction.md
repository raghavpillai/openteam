# Introduction

OpenTeam runs a team of AI bots on hardware you control. Each bot gets its own screen, browser, and terminal on your server, so it can research, work through websites, handle files, and use the apps you connect. You give it work in chat and review the results.

## How it fits together

- **Your server** runs on a machine you choose: your own computer, a home server, or a cloud VM. It stores your data and runs your bots.
- **A model provider** supplies the AI. Sign in with ChatGPT or Claude, add an API key, or point OpenTeam at your own endpoint.
- **The apps** connect to your server. Use the desktop app to chat with bots, watch their screens, and manage settings, or build the iPhone app from source. Closing an app doesn't stop work on the server.

## What a bot has

| Part | What it does |
| --- | --- |
| [Conversation](../usage/conversations.md) | Where you give tasks and get results. Bots can also work together in group chats. |
| [Computer](../usage/computer.md) | Its own Linux screen and browser. You can watch it work or take over. |
| [Workspace](../usage/files.md) | A shared `/workspace` folder where all your bots read and write files. |
| [Memory](../usage/memory.md) | Preferences and facts it carries from one task to the next. |
| [Skills](../usage/skills.md) | Saved instructions for work you repeat. |
| [Plugins](../usage/plugins.md) | Access to services such as Gmail, GitHub, Slack, and Notion. |
| [Routines](../usage/routines.md) | Tasks it runs on a schedule or when an event arrives. |

## An example

Attach a spreadsheet and ask:

> Compare the suppliers in this file by price and delivery time. Make a shortlist of three, explain the tradeoffs, and attach a Markdown report. Flag any missing information.

The bot opens the file, checks supplier websites in its browser, and writes the report. If it needs a decision or an account, it asks you in the chat. When it's done, the report is attached to the conversation.

## Get started

- **New to OpenTeam?** Follow the [quickstart](../getting-started/quickstart.md).
- **Deciding where to host?** Read [how hosting works](architecture.md).
- **Looking for ideas?** Browse the [use cases](use-cases.md).
