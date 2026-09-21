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
5. Leave **Sign-in callback → Automatic** selected. For an HTTPS OpenTeam address, create a **Web application** OAuth client and register the exact callback shown in account settings: `https://<your-server>/api/v0/plugin-oauth/callback`. This deployment-wide URL works for all accounts.
6. If the OpenTeam address is HTTP, create a **Desktop app** OAuth client for callback paste. This headless fallback uses `http://127.0.0.1:42813/callback`; it does not need a listener on the phone or laptop. Do not create an iOS OAuth client for this flow.
7. Save the client ID and secret in the account setup form. The account becomes **Ready to authorize**. It becomes **Connected** only after sign-in and tool discovery succeed.

Google's [credential setup guide](https://developers.google.com/workspace/guides/create-credentials) explains application registration. A Desktop app client and a Web application client are different registrations. When changing callback methods, update the credentials and registered redirect together.

## Choose the callback route

**Tailscale HTTPS is the preferred private setup.** On a running Tailscale node with HTTPS certificates enabled, OpenTeam setup proposes the node's HTTPS name when its private address belongs to that node and Serve can safely proxy OpenTeam. It reuses a matching route or creates a persistent private route. Existing routes for other services, foreground Serve sessions, and Funnel exposure are not replaced. If HTTPS cannot be configured, setup keeps private HTTP and compatible plugins use callback paste. See [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

For a custom domain, use OpenTeam's existing Caddy option or your own HTTPS proxy. Set `OPENTEAM_PUBLIC_URL` to the canonical HTTPS address. Both iOS and desktop open Google in the signing-in device's browser; Google redirects that browser to your server. The browser needs access to the server (including Tailscale when used); no OpenTeam-operated relay is involved.

With **HTTP / callback paste**, approve access, then copy the full address of the localhost page even when the browser reports that it cannot connect. Return to the same OpenTeam app session and paste the URL into **Complete callback URL**. Use this dedicated form, never chat. The backend validates the redirect, state, expiry, and initiating session before exchanging the code with PKCE. Tests cover this protocol with a local provider; Google's real consent and failed-page copy experience on iPhone still require device acceptance testing. This is a loopback redirect, not Google's retired OOB redirect type.

The server keeps and refreshes tokens independently of either app. HTTP access should stay on a trusted private network such as Tailscale. A provider that requires HTTPS will explain that requirement instead of starting callback paste.

**Desktop listener (advanced)** remains available for an explicitly configured connection. It receives the callback on the desktop computer and relays it to the backend. For providers requiring a fixed port, set **Desktop callback port** and register `http://127.0.0.1:PORT/callback`; `0` selects an available port. iOS directs this explicit mode to desktop setup. New connections default to Automatic.

Existing Web clients registered with a per-account `connectionId` query must register the new stable callback before starting a new sign-in. Already-issued tokens are retained; changing saved connection settings clears authorization and requires signing in again.

## Authorize each account

Choose **Save and authorize** in OpenTeam, select the intended Google identity, and review the requested permissions. After connection, test a small read:

| Plugin | Example test |
| --- | --- |
| Gmail | `get_profile` with `{}` |
| Calendar | `list_calendars` with `{}` |
| Drive | `list_recent_files` with `{"pageSize":5}` |

Confirm the account and returned data, then grant the account to the intended bots. Repeat for each plugin. For another identity, add an account and authorize it separately. All Server callback accounts use the same registered deployment URL; each sign-in has independent state and tokens.

## What bots can do

- **Gmail:** find and read mail, organize labels, and prepare drafts and replies. The bundled connector does not send mail.
- **Calendar:** find events, inspect availability, and create or update events. Changes can notify attendees; specify your intent and review the proposed action.
- **Drive:** find files, read supported documents, upload or copy files, and work with supported comments. Some writes are limited to files the OAuth application can access.

A connected account does not bypass its sharing permissions. File extraction can also have format and size limits; ask the bot what it could read when a result is incomplete.

## Fix common problems

For a redirect mismatch, first check that the Google client type matches the selected callback mode. In Server mode, compare the complete callback URL with the registered value. If desktop reports an occupied callback port, use automatic port selection or resolve the fixed-port conflict. For an access error, check the selected identity, enabled API, requested scopes, and Workspace policy.

If authorization repeatedly expires, inspect the OAuth application's testing or publishing state and reauthorize as needed. For general recovery, use [connection troubleshooting](accounts.md#troubleshooting).
