# Approvals and privacy

You decide which accounts and computers each bot can use, and which actions need your OK first.

## Answer an approval request

When a bot wants to do something that needs your permission, it shows a card in the chat and waits. Check what it wants to do and where, then choose:

| Choice | What happens |
| --- | --- |
| **Allow once** | The bot does this one action |
| **Always allow** | Stops asking for this kind of action |
| **Deny** | The bot doesn't do it. Tell it what to do instead. |
| **Never** | Blocks this kind of action from now on. Offered for actions on your own computer. |

On iPhone, the choices are **Approve once**, **Always allow**, and **Deny**.

For a plugin tool, **Always allow** applies only to the bot that asked. For actions on your own computer, **Always allow** and **Never** change [Execution on this computer](../usage/computer.md#use-your-own-computer) for all bots.

An approved action can't be undone by OpenTeam. If a task stops partway through, check the result (for example, whether a message was already sent) before you ask the bot to try again.

## Control plugin access

Plugins have two layers of control:

- **Bot access:** a bot can only use the plugin accounts you turn on for it.
- **Tool policies:** for each tool, choose **Allow** to let it run, **Ask first** to require your approval, or **Deny** to block it. Policies apply to all bots.

These settings can only narrow what the connected account can do. They can't give a bot more access than the account itself has.

## Auto-review

Auto-review checks each action before it runs and asks you when it's needed. It's on by default, and you can turn it off in **Settings → General → Auto-review**. The setting and its rules apply to your whole server.

Add **Auto-review Rules** to adjust what it allows. Each rule describes an action in plain words and what to do about it:

- **When OpenTeam wants to:** reply to emails for me
- **It should:** **Ask first**

The other option is **Allow automatically**.

## Control access to your computer

Bots can only use your own computer if you allow it in the desktop app. See [use your own computer](../usage/computer.md#use-your-own-computer).

## Where your data goes

- **Your server** stores your conversations, files, memory, and settings.
- **Your model provider** receives what the bot needs to work on each task, including messages and file contents.
- **Connected services** receive the requests bots make through plugins.
- **Your web search and transcription providers** receive search queries and voice recordings.

Self-hosting keeps your data on your server, but these services still see what's sent to them. To keep model requests local too, use your [own model server](models.md#use-your-own-model-server).

## Things to know

- **Bots share some things.** All bots can read the `/workspace` folder and use the same website sign-ins. Use **Bot access** to decide which bots can use which accounts.
- **Keep secrets out of chat.** Enter passwords in the website's own sign-in form, and tokens in plugin setup forms.
- **Protect your backups.** They include website sign-ins and connected accounts.

To take access away, turn the account off under **Bot access**, or disconnect it entirely. See [manage a plugin](../usage/plugins.md#manage-a-plugin).
