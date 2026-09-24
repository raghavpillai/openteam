# Approvals and privacy

You decide which accounts each bot can use, whether bots can use your computers, and which actions need your OK first.

## Answer an approval request

When a bot wants to do something that needs your permission, it shows a card in the chat and waits. Check what it wants to do and where, then choose:

| Choice | What happens |
| --- | --- |
| **Allow once** | The bot does this one action |
| **Always allow** | Stops asking for this kind of action (see below). Not offered on every card. |
| **Deny**, **Deny once**, or **×** | The bot doesn't do it. Tell it what to do instead. |
| **Never** | Turns off bots' access to your computer. Offered for actions on your own computer. |

What **Always allow** covers depends on the card:

- **A plugin tool:** saves an **Allow** policy for that bot, account, and tool. A **Deny** policy for all bots still blocks it.
- **An action on your own computer:** sets [Execution on this computer](../usage/computer.md#use-your-own-computer) to **Always allow** for all bots. **Never** sets it to **Never allow**.
- **An auto-review check:** adds the [auto-review rule](#auto-review) shown on the card, for all bots.

Auto-review can still ask about individual actions after you choose **Always allow**.

On iPhone, the choices are **Approve once**, **Always allow**, **Deny**, and, for your own computer, **Never allow**.

An approved action can't be undone by OpenTeam. If a task stops partway through, check the result (for example, whether a message was already sent) before you ask the bot to try again.

## Control plugin access

Plugins have two layers of control:

- **Bot access:** a bot can only use the plugin accounts you turn on for it.
- **Tool policies:** for each tool, choose **Allow** to let it run, **Ask first** (**Ask each time** on iPhone) to require your approval, or **Deny** to block it. Policies are set per account. On desktop they apply to all bots; on iPhone you can also set one for a single bot.

These settings can only narrow what the connected account can do. They can't give a bot more access than the account itself has. See [plugins](../usage/plugins.md#control-what-bots-can-do) for where to find them.

## Auto-review

Auto-review checks each action before it runs and asks you when it's needed. It's on by default, and you can turn it off in **Settings → General → Auto-review**. The setting and its rules apply to your whole server.

Add **Auto-review Rules** to adjust what it allows. Each rule describes an action in plain words and what to do about it:

- **When OpenTeam wants to:** reply to emails for me
- **It should:** **Ask first**

The other option is **Allow automatically**. On iPhone, find them under **Settings → More preferences → Auto-review rules**, listed as **Allow** and **Block**.

## Where your data goes

- **Your server** stores your conversations, files, memory, and most settings. Device preferences and computer permissions stay on each device.
- **Your model provider** receives what the bot needs to work on each task, including messages and file contents.
- **Connected services** receive the requests bots make through plugins.
- **Your web search, web fetch, and transcription providers** receive search queries, the addresses of pages bots fetch, and voice recordings.

Self-hosting keeps your data on your server, but these services still see what's sent to them. To keep model requests local too, use your [own model server](models.md#use-your-own-model-server).

## Things to know

- **Your own computer is off-limits unless you allow it** in the desktop app. See [use your own computer](../usage/computer.md#use-your-own-computer).
- **Bots share some things.** All bots can read the `/workspace` folder and use the same website sign-ins. Use **Bot access** to decide which bots can use which accounts.
- **Keep secrets out of chat.** Enter passwords in the website's own sign-in form, and tokens in plugin setup forms.
- **Protect your backups.** They include connected-account credentials and website sign-ins.

To take access away, turn the account off under **Bot access**, or choose **Remove account** to delete it (a plugin's only account is reset instead). See [manage a plugin](../usage/plugins.md#manage-a-plugin).
