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
VPN applications may still need service configuration.

## What restarts and updates keep

When OpenTeam updates, or recreates the computer after a settings change, the computer starts again from a fresh image and keeps only these:

- The bots' home folder and `/workspace`. This includes each bot's browser profile: sign-ins, history, bookmarks, settings and extension data. Tabs that were open aren't reopened.
- `/usr/local`, where `sudo pip install`, `sudo npm install -g`, `make install` and hand-copied tools go.
- apt packages. The computer records each package a bot installs, the apt sources and keys it added, and `.deb` files it installed, and reinstalls them in the background when it starts. Packages from Debian come back at the new image's version.
- pip and npm packages, which are reinstalled or rebuilt when an update changes the Python or Node.js version.

Everything else, such as `/tmp`, manual changes under `/etc`, and files in `/opt` or other folders, starts fresh. The image's own tools and libraries always come back as the image's version, so an update's fixes reach every bot. Commands bots add to `/usr/local/bin` or their home folder run by name, but a copy with the same name as one of the system's tools doesn't replace it, in login shells and `sudo` too; bots call such a copy by its full path.

If a package can't come back (its apt source is gone, or it was installed from a `.deb` that wasn't kept), each bot is told once, and the computer tries again only after its image changes. Bots run `openteam-installs` to see what's recorded and `sudo openteam-installs forget NAME` to stop tracking a package: it isn't reinstalled at start and no bot is told about it, until it's removed and installed again. An apt source a bot removes stays removed. To start over with no installed software, stop OpenTeam and remove the `openteam_openteam_computer_local` volume.

## Use your own computer

The desktop app can connect your own computer to OpenTeam, so bots can work with local files and tools. The app makes an outgoing connection, so you don't need to open any ports.

With your permission, a bot can:

- Run commands on your computer (macOS and Linux only)
- Read files on your computer
- Copy files between your computer and its `/workspace`
- On a Mac: read your contacts, read and send Messages, and import your Chrome sign-ins into its browser

Bots don't get a view of your screen or control of your mouse and keyboard. They work through commands and files.

Bots execute commands, transfers, and available native tools directly on enrolled computers. To stop access, disable the computer from its **…** menu under **Settings → Server → Manage devices** or close the desktop app.

Your computer may ask you to grant OpenTeam permissions, such as access to Contacts.

### Messages on a Mac

Bots can use Messages only on a Mac where you turn it on:

1. On that Mac, open **Settings → Computer** in the desktop app and turn on **Use Messages**, or choose **Set up** next to **Messages** under **This Mac** in **Marketplace**.
2. A window lists the macOS permissions Messages needs. Choose **Allow** next to each: **Automation** lets bots send through Messages, **Contacts** lets them find people by name, and **Full Disk Access** lets them search your texts. macOS doesn't ask for Full Disk Access, so **Allow** opens System Settings, where you turn on OpenTeam. Reopen the window any time from **macOS permissions** in the same section. If a bot needs a permission you haven't granted, the window opens on that Mac.

Before a bot sends a text, a **Send this message?** card shows the recipient, the text and the Mac it goes out from, in the desktop and iPhone apps. Choose **Send**, **Discard**, or **Always allow** to let bots text that person from that Mac without asking. **Send Without Asking** skips the card for every text. **Allowed recipients** under **Settings → Computer → Messages** lists the people you've allowed, with a button to remove each. Turning Messages off and on again clears both.

With Messages on for more than one Mac, a bot uses the Mac you last wrote from, or the only one that's online. A Mac goes offline when it sleeps or its app closes, so closing a MacBook moves Messages to another Mac that's awake. **Settings → Server → Manage devices** shows each computer as online now or when it was last opened, and whether Messages is on there. The iPhone app has the same list under **Settings → Server → Manage devices**.

Keep the desktop app open while a bot works on your computer. When you give a task, say which computer you mean, because the bot's Linux computer and your own computer have different files.

## Route browser traffic through a connected computer

Bot browsers can use an enrolled Mac or Linux computer's internet connection while the browsers continue running on your server. Websites see the selected computer's connection; browser profiles and sign-ins stay on the bot computer.

1. Update the OpenTeam server, computer runtime, and desktop app together.
2. On the computer that will provide the connection, open **Settings → Server → Browser network** and turn on **Use this computer as network**. Check the server address before allowing it. The computer automatically joins the saved connection priority; no separate Add step is needed.
3. Drag connections by their handles, or focus a handle and use Space, arrow keys, then Space to drop (Escape cancels). Choose **Apply** to save a new order. The same priority applies to every managed bot browser.

Browser networking always follows this ranked list. On iOS, open **Settings → Server → Browser network** to manage the same list using native drag handles or accessibility move actions, then **Apply priority**. iOS manages computer providers; the phone itself is not an exit provider. **Server connection** is part of the same list and can be placed anywhere. OpenTeam uses the highest available connection: for example, **MacBook Air → Mac mini → Server connection**. A computer below the server will not be used while the server is available.

Each computer shows **Working** when its locally approved network channel has a fresh lease, or **Not working** otherwise. The active source shows an **In use** pill. On desktop, **(current)** beside a computer identifies this enrolled computer, independently of which source is in use. **Exit IP** and **Location** show the active browser connection's public address and approximate IP-based location. Click or tap each value to reveal it; click or tap again to hide. Values hide again when the route changes or the app leaves the foreground. A bounded HTTPS lookup to ipwho.is travels through that same browser route, with device-side DNS when a computer provides it. Checks run only while these settings are open, cache for two minutes, and show **Unavailable** on failure instead of retaining an old address.

Keep provider computers awake with OpenTeam running. Closing a MacBook's lid so it sleeps, quitting the app, losing its channel, or stopping sharing makes that computer unavailable. Ranked mode moves to the next available entry; if every computer is offline, it reaches the server's entry. A returning higher-priority computer must stay online for 30 seconds before taking over, to avoid repeated switches on an unstable connection. An unresponsive connection loses eligibility when its 6-second lease expires. Individual website failures do not trigger source hopping.

Switching is driven by the network channel, independently of the settings screen's refresh interval. Sleep and disconnect notifications trigger fallback immediately; a silent lost connection expires after six seconds, with renewals every two seconds. Approved fallback computers keep their channels connected. A new route becomes usable only after its exit acknowledges it. Requests that have not been sent can wait up to two seconds during that handshake; existing transfers are interrupted and are never replayed.

Use **Connection test → Test** in Server settings on desktop or iOS to check the active browser exit. It shows request latency in milliseconds and approximate download/upload speed in Mbps. The test travels from the bot computer through its active exit to Cloudflare's public test endpoint, using device-side DNS for a computer exit. It measures this complete route, including relay overhead; it does not test the iPhone's internet connection. It uses a 1 MiB download and 256 KiB upload, runs only when requested, has a 20-second deadline, and caches results for one minute. Small samples are quick estimates rather than a maximum-bandwidth benchmark. Changing exits clears the previous result; test failures do not change your ranking or replay website requests.

To prefer the server, move **Server connection** to the top and apply. Closing only the desktop window may leave the app running and sharing active. Existing server/device selections migrate to a ranked list preserving their previous first choice, with the server included as fallback.

Changing connections interrupts active downloads and website connections. Pages stay open. OpenTeam does not replay requests or submissions; check the outcome before retrying an action.

This setting includes page requests, browser uploads/downloads, and website WebSockets. Terminal commands, model requests, WebFetch, and plugins keep their existing connections. Device routing allows public destinations on ports 80 and 443; local/private addresses, other ports, and UDP are blocked. It does not provide access to the device's local files or import its browser cookies. Windows and phones cannot provide this connection yet.

A VPN follows the selected computer's OS routing. Networks requiring an application-level proxy or PAC configuration may not work. Routing through your own connection does not remove website login requirements, CAPTCHAs, or automation restrictions.

To stop sharing locally, turn off the sharing switch or quit the app. Disable the computer in **Connected computers** to revoke its enrollment. Turning sharing off retains the saved priority order and advances to its next available entry. Enabling sharing again preserves that position and does not add duplicates. A new computer joins before a last-ranked server; an explicitly elevated server keeps its priority.

## If the screen won't load

Check that the server is running with `openteam status`. If the preview says **Computer setup needs attention**, choose **Retry setup**. For work on your own computer, check that the desktop app is open and connected. See [troubleshooting](../manage/troubleshooting.md#the-screen-doesnt-load).
