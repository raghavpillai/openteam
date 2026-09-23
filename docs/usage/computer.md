# Computer and browser

Each bot has its own screen on the server's Linux computer, with a browser and a terminal. You can watch it work and step in when it needs you. With the desktop app, bots can also work on your own computer.

## Watch a bot's screen

Open a bot and choose the computer button at the top right of the conversation. A preview shows the bot's screen live. Select the preview to open it full size.

The full-size view is live, so you can click and type in it. Avoid doing so while the bot is mid-task, or you'll get in each other's way.

## Take over when the bot needs you

Some steps need a person, such as a sign-in, a CAPTCHA, or a decision on a website. When that happens, the bot posts a **Take over the computer** card in the chat.

1. Choose **Take over** to open the bot's screen.
2. Complete the step.
3. Choose **I'm done, continue** to hand control back. Choose **Skip this step** if you can't or don't want to do it.

On iPhone, use **Take control** and **Give back control** on the bot's screen.

## Sign in to websites

Bots' browsers share sign-ins, so once you sign in to a site on one bot's screen, all your bots are signed in. Sign-ins last across restarts.

There are two ways to sign a bot in:

- **Type it yourself.** Take over the bot's screen and sign in to the site directly. Never paste a password into the chat.
- **Use saved logins.** Connect a 1Password vault in **Settings → Computer → Saved logins and Mac access**. A bot can then ask to fill a saved login into its browser, and you approve the request. Passwords never appear in the conversation. This needs 1Password and the desktop app on a Mac, and only works on HTTPS sites.

Some sites block automated browsers or ask for extra verification. If that happens, take over to finish the step, or ask the bot to find another way.

## Use your own computer

The desktop app can connect your own computer to OpenTeam, so bots can work with local files and tools. The app makes an outgoing connection, so you don't need to open any ports.

With your permission, a bot can:

- Run commands on your computer (macOS and Linux)
- Read files on your computer
- Copy files between your computer and its `/workspace`
- On a Mac: read your contacts, read and send Messages, and import your Chrome sign-ins into its browser

Bots can't see or control your screen.

To control access, open **Settings → Computer → Execution on this computer** and choose:

| Setting | What happens |
| --- | --- |
| **Ask every time** | You approve each action |
| **Always allow** | Bots run actions without asking. If [auto-review](../configuration/approvals.md#auto-review) is on, it still checks each one. |
| **Never allow** | Bots can't use this computer |

Your computer might also ask you to grant OpenTeam permissions, such as access to Contacts. Keep the desktop app open while a bot works on your computer.

When you give a task, say which computer you mean. The bot's Linux computer and your own computer have different files.

## If the screen won't load

Check that the server is running with `openteam status`. If the preview says **Computer setup needs attention**, choose **Retry setup**. For work on your own computer, check that the desktop app is open and connected. See [troubleshooting](../manage/troubleshooting.md#the-screen-doesnt-load).
