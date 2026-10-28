# Computer and browser

Each bot has its own screen on the server's Linux computer, with a browser and a terminal. You can watch it work and step in when it needs you. With the desktop app, bots can also work on your own computer.

## Watch a bot's screen

Open a bot and choose the computer button at the top right of the conversation. Select the screen preview to open the bot's screen full size. After you've opened it once, the preview refreshes every few seconds while the panel is open.

The full-size view is live, so you can click and type in it. Avoid doing so while the bot is mid-task, or you'll get in each other's way.

## Take over when the bot needs you

Some steps need a person. When that happens, the bot posts a card in the chat asking you to take over (**Take over the computer** on desktop).

1. Choose **Take over** to open the bot's screen.
2. Complete the step.
3. Choose **I'm done, continue** to hand control back. Choose **Skip this step** if you can't or don't want to do it.

On iPhone, the card is titled **Your help is needed** and offers **Take over** and **Skip**. Tap **Done** when you've finished. To step in at other times, open the bot's screen and choose **Take control** from the **⋯** menu.

## Sign in to websites

Bots' browsers share sign-ins, so once you sign in to a site on one bot's screen, all your bots are signed in. Sign-ins that the site remembers last across restarts.

There are two ways to sign a bot in:

- **Type it yourself.** Take over the bot's screen and sign in to the site directly. Never paste a password into the chat.
- **Use saved logins.** Add the **1Password** plugin with a read-only service account token. The bot looks up the matching login with the 1Password CLI and types it into the site. Values it reads appear in the conversation.

Some sites block automated browsers or ask for extra verification. If that happens, take over to finish the step, or ask the bot to find another way.

## Administrator commands

Bots can use passwordless `sudo` to install system packages and change their Linux
computer. This gives them access to all container files, including provider
credentials. The container has all Linux capabilities, unrestricted seccomp and LSM
profiles, writable kernel filesystems, an executable `/tmp`, and `/dev/net/tun` for
VPN clients. Main, executor, computerUse and knowledgeWork workers can use sudo;
video workers review supplied media without tools. This shares the
Docker host kernel; it does not provide a separate VM security boundary.
System packages survive restarts but must be reinstalled after container recreation
or upgrades. VPN applications may still need service configuration.

## Use your own computer

The desktop app can connect your own computer to OpenTeam, so bots can work with local files and tools. The app makes an outgoing connection, so you don't need to open any ports.

With your permission, a bot can:

- Run commands on your computer (macOS and Linux only)
- Read files on your computer
- Copy files between your computer and its `/workspace`
- On a Mac: read your contacts, read and send Messages, and import your Chrome sign-ins into its browser

Bots don't get a view of your screen or control of your mouse and keyboard. They work through commands and files.

Bots execute commands, transfers, and available native tools directly on enrolled computers. To stop access, disable the computer under **Settings → Computer → Computers** or close the desktop app.

Your computer may ask you to grant OpenTeam permissions, such as access to Contacts.

### Messages on a Mac

Bots can use Messages only on a Mac where you turn it on:

1. On that Mac, open **Settings → Computer** in the desktop app and turn on **Use Messages**.
2. A window lists the macOS permissions Messages needs. Choose **Allow** next to each: **Automation** lets bots send through Messages, **Contacts** lets them find people by name, and **Full Disk Access** lets them search your texts. macOS doesn't ask for Full Disk Access, so **Allow** opens System Settings, where you turn on OpenTeam. Reopen the window any time from **macOS permissions** in the same section. If a bot needs a permission you haven't granted, the window opens on that Mac.

Before a bot sends a text, a **Send this message?** card shows the recipient, the text and the Mac it goes out from, in the desktop and iPhone apps. Choose **Send**, **Discard**, or **Always allow** to let bots text that person from that Mac without asking. **Send Without Asking** skips the card for every text. **Allowed recipients** under **Settings → Computer → Messages** lists the people you've allowed, with a button to remove each. Turning Messages off and on again clears both.

With Messages on for more than one Mac, a bot uses the Mac you last wrote from, or the only one that's online. A Mac goes offline when it sleeps or its app closes, so closing a MacBook moves Messages to another Mac that's awake. **Settings → Computer → Computers** shows which Macs have Messages on.

Keep the desktop app open while a bot works on your computer. When you give a task, say which computer you mean, because the bot's Linux computer and your own computer have different files.

## If the screen won't load

Check that the server is running with `openteam status`. If the preview says **Computer setup needs attention**, choose **Retry setup**. For work on your own computer, check that the desktop app is open and connected. See [troubleshooting](../manage/troubleshooting.md#the-screen-doesnt-load).
