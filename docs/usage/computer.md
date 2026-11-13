# Computer and browser

Each bot has its own screen on the server's Linux computer, with a browser and a terminal. You can watch it work and step in when it needs you. With the desktop app, bots can also work on your own computer.

## Watch a bot's screen

Open a bot and choose the computer button at the top right of the conversation.

On desktop, this opens a panel with a preview of the bot's screen. After you've opened it once, the preview refreshes every few seconds while the panel is open. Select the preview to open the screen full size. On iPhone and iPad, the computer button opens the screen full size directly. Both start in **Watching** mode, so the bot can keep working.

Choose **Take control** to click and type: in the control bar below the screen on desktop, iPhone, and iPad. The status changes to **You’re in control**. The bot can keep chatting and doing other work, but cannot use this computer's screen or browser while you control it. Choose **Stop** to give back control when you finish, or close the viewer (**Done** on iPhone).

There is no inactivity countdown or renewal requirement. A dropped connection, a backgrounded iPhone app, or a restart of the server or bot computer preserves your control. While the screen reconnects, it shows **Reconnecting — your control is reserved**. Check the current screen before retrying an action; disconnected input is not replayed.

If another viewer holds control, the screen shows **Controlled on another device** and stays view-only. Choose **Take control here** to move control to this viewer, or **Resume bot** to return it to the bot. Simply watching or closing a viewer does not release another viewer's control. You can use these actions to recover after an app crash, or if the original device is unavailable.

## Take over when the bot needs you

Some steps need a person. When that happens, the bot posts a card in the chat asking you to take over (**Take over the computer** on desktop, **Your help is needed** on iPhone).

1. Choose **Take over** to open the bot's screen.
2. Complete the step.
3. Choose **I'm done** below the screen to complete the requested step, return control, and let the bot continue. If you can't or don't want to do the step, use **Skip** on the request card or **Skip this step** in the desktop viewer.

To decline without opening the screen, choose **Skip** on the card.

## Sign in to websites

Bots' browsers share sign-ins, so once you sign in to a site on one bot's screen, all your bots are signed in. Sign-ins that the site remembers last across restarts.

There are three ways to sign a bot in:

- **Type it yourself.** Take over the bot's screen and sign in to the site directly. Never paste a password into the chat.
- **Fill in a secure form.** When a page needs something you have to type, such as a login or a one-time code, the bot can show a form in the chat. Passwords and codes you enter there go straight into the page in the bot's browser; the bot never sees them.
- **Use saved logins.** Add the **1Password** plugin with a read-only service account token. The bot looks up the matching login with the 1Password CLI and types it into the site. Values it reads appear in the conversation.

On a Mac, a bot can also import your Chrome sign-ins; see [use your own computer](#use-your-own-computer).

Some sites block automated browsers or ask for extra verification. If that happens, take over to finish the step, or ask the bot to find another way.

## Administrator commands

Bots can use `sudo` without a password to install software and change their Linux computer. That also lets them read every file in the computer's container, including your provider credentials. The computer is a Docker container that shares the host's kernel, not a separate virtual machine. VPN apps can run there but may need extra setup.

## What restarts and updates keep

When OpenTeam updates, or recreates the computer after a settings change, the computer starts again from a fresh image. It keeps the bots' home folder and `/workspace`, including each bot's browser profile and sign-ins (open tabs aren't reopened). It also keeps everything under `/usr/local`, where `sudo pip install` and `sudo npm install -g` put software, and it reinstalls apt packages that bots installed. Everything else, such as `/tmp`, changes under `/etc` and files in `/opt`, starts fresh. If a package can't be reinstalled, the bots are told. To see what the computer reinstalls, ask a bot to run `openteam-installs`.

## Use your own computer

When you sign in to the desktop app, it connects that computer to OpenTeam, so bots can work with local files and tools. The app makes an outgoing connection, so you don't need to open any ports.

A bot can:

- Run commands on your computer (macOS and Linux only)
- Read files on your computer
- Copy files between your computer and its `/workspace`
- On a Mac: import your Chrome sign-ins into its browser for the sites a task needs, and, if you turn on [Messages](#messages-on-a-mac), find your contacts and read and send texts

Bots don't get a view of your screen or control of your mouse and keyboard. They work through commands and files, and they run commands, file transfers and Chrome sign-in imports without asking first. Your computer may ask you to grant OpenTeam permissions, such as access to Contacts.

To stop access, quit the desktop app, or disable the computer from another device: open **Settings → Server → Manage devices** and choose **Disable** from the computer's **…** menu on desktop, or swipe its row on iPhone.

### Messages on a Mac

Bots can use Messages only on a Mac where you turn it on:

1. On that Mac, open **Settings → Computer** in the desktop app and turn on **Use Messages**, or choose **Set up** next to **Messages** under **This Mac** in **Marketplace**.
2. A window lists the macOS permissions Messages needs. Choose **Allow** next to each: **Automation** lets bots send through Messages, **Contacts** lets them find people by name, and **Full Disk Access** lets them search your texts. macOS doesn't ask for Full Disk Access, so **Allow** opens System Settings, where you turn on OpenTeam. Reopen the window any time from **macOS permissions** in the same section. If a bot needs a permission you haven't granted, the window opens on that Mac.

Before a bot sends a text, a **Send this message?** card shows the recipient, the text and the Mac it goes out from, in the desktop and iPhone apps. Choose **Send**, **Discard**, or **Always allow** to let bots text that person from that Mac without asking. **Send Without Asking** skips the card for every text. **Allowed recipients** under **Settings → Computer → Messages** lists the people you've allowed, with a button to remove each. Turning Messages off and on again clears both.

Bots can also send photos and files through Messages: ask for the files by their paths on the bot computer. The approval card shows the attachments on desktop and iPhone before sending, with a limit of ten files and 25 MiB combined. OpenTeam keeps a copy for review so later file changes do not change what you approved. File delivery still depends on the selected Mac and the messaging service.

With Messages on for more than one Mac, a bot uses the Mac you last wrote from, or the only one that's online. A Mac goes offline when it sleeps or its app closes, so closing a MacBook moves Messages to another Mac that's awake. **Settings → Server → Manage devices** shows each computer as online now or when it was last opened, and whether Messages is on there. The iPhone app has the same list under **Settings → Server → Manage devices**.

Keep the desktop app open while a bot works on your computer. When you give a task, say which computer you mean, because the bot's Linux computer and your own computer have different files.

## Route computer traffic through a connected computer

The bot computer can use the internet connection of a Mac or Linux computer running the desktop app, so websites see that computer's connection. Bots, browser profiles and sign-ins stay on your server, and sharing doesn't give bots that computer's files.

1. On the computer that will share its connection, open **Settings → Server** in the desktop app and turn on **Share this computer’s connection** under **Computer network**. Check the server address before allowing it. The computer joins the connection list.
2. Drag the connections into the order you want, then choose **Apply**. On iPhone or iPad, open **Settings → Server**, reorder the **Browser network** list (or use **Move up** and **Move down**), then choose **Apply**.

OpenTeam uses the highest available connection. **Server connection** is always in the list; computers below it aren't used.

Everything on the bot computer is routed, including its browser, terminal commands and plugins that run there. Model requests, web fetch and plugins in other containers keep the server's connection. UDP other than DNS isn't supported.

Shared-computer connections block local and private destinations. **Server connection** can reach private networks accessible from the bot computer's container. Web fetch always blocks local and private destinations.

When a computer sleeps, quits the app or stops sharing, OpenTeam moves to the next connection. Switching drops open downloads and connections. Pages stay open, but nothing is replayed, so check whether an action went through before retrying it. **Connection test → Test** checks the active connection's speed, and **Exit IP** shows the address and approximate location websites see.

To stop sharing, turn off the switch or quit the app (on a Mac, closing the window leaves the app running). Windows computers and phones can't share a connection.

## If the screen won't load

Check that the server is running with `openteam status`. If the preview says **Computer setup needs attention**, choose **Retry setup**. For work on your own computer, check that the desktop app is open and connected. See [troubleshooting](../manage/troubleshooting.md#the-screen-doesnt-load).
