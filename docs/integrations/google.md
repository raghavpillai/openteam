# Google

Connect Gmail, Google Calendar, and Google Drive so bots can use your mail, events, and files. Set up only the plugins you need.

## Before you start

You need a Google account and permission to configure an OAuth application in a Google Cloud project. A Workspace administrator may need to allow the requested access.

OpenTeam uses bundled connectors for Google's public APIs. Each plugin account needs authorization; connecting Gmail does not connect Calendar or Drive.

## Configure Google access

1. Install the desired plugin in OpenTeam. Open **Manage plugins → Installed** and select its account.
2. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project. Enable the API for each plugin you will use: **Gmail API**, **Google Calendar API**, or **Google Drive API**.
3. Configure the OAuth application's consent details and audience. If it is in testing, include the identities you intend to authorize as test users.
4. Add the scopes shown in OpenTeam's **Requested scopes**. When reusing one OAuth client across plugins, include the required scopes for each.
5. For the desktop app, create an OAuth client with application type **Desktop app**. Keep **Sign-in callback → Desktop** in account settings. You do not need a public hostname or a registered server callback.
6. Enter the client ID and required client secret in the OpenTeam account's setup form.

Google's [credential setup guide](https://developers.google.com/workspace/guides/create-credentials) explains application registration. Google still requires an OAuth client even when the callback is local.

The desktop temporarily listens on `http://127.0.0.1:<available-port>/callback` on the computer running your browser. It sends the authorization code to your selected OpenTeam server, which verifies the session, exchanges the code, and stores tokens in its database. The server can run on a different computer and continues refreshing tokens after you close the desktop app. Protect the desktop-to-server connection with HTTPS, SSH, or an encrypted VPN; Tailscale is optional.

For **browser-only use or an existing Web application client**, select **Server callback** in account settings and register each exact server callback, including its `connectionId` query parameter. Google requires HTTPS for non-loopback web callbacks; an HTTP private-network IP is not a substitute for localhost. Keep the server address stable. A Desktop app client and a Web application client are different registrations.

For other providers that require a fixed desktop callback, set **Desktop callback port** and register `http://127.0.0.1:PORT/callback`. The default `0` chooses an available port. The listener binds only to this computer, closes after completion/cancellation/timeout, and is cancelled when the plugin dialog closes or you switch plugins, server, or login session. Reopen sign-in to restart a cancelled listener. A browser tab closed by itself can be reopened while the listener remains active.

This desktop listener is not an iOS implementation. Google iOS authorization needs its supported native SDK/server authorization-code flow or a suitable HTTPS flow; Google does not support desktop loopback redirects for iOS clients.

## Authorize each account

Choose **Save and authorize** in OpenTeam, select the intended Google identity, and review the requested permissions. After connection, test a small read:

| Plugin | Example test |
| --- | --- |
| Gmail | `get_profile` with `{}` |
| Calendar | `list_calendars` with `{}` |
| Drive | `list_recent_files` with `{"pageSize":5}` |

Confirm the account and returned data, then grant the account to the intended bots. Repeat for each plugin. For another identity, add an account and authorize it separately. Only the Server callback flow needs a separately registered server callback for each account.

## What bots can do

- **Gmail:** find and read mail, organize labels, and prepare drafts and replies. The bundled connector does not send mail.
- **Calendar:** find events, inspect availability, and create or update events. Changes can notify attendees; specify your intent and review the proposed action.
- **Drive:** find files, read supported documents, upload or copy files, and work with supported comments. Some writes are limited to files the OAuth application can access.

A connected account does not bypass its sharing permissions. File extraction can also have format and size limits; ask the bot what it could read when a result is incomplete.

## Fix common problems

For a redirect mismatch, first check that the Google client type matches the selected callback mode. In Server mode, compare the complete callback URL with the registered value. If desktop reports an occupied callback port, use automatic port selection or resolve the fixed-port conflict. For an access error, check the selected identity, enabled API, requested scopes, and Workspace policy.

If authorization repeatedly expires, inspect the OAuth application's testing or publishing state and reauthorize as needed. For general recovery, use [connection troubleshooting](accounts.md#troubleshooting).
