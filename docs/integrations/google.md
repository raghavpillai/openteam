# Google

Connect Gmail, Google Calendar, and Google Drive so bots can work with your email, events, and files. Each is a separate plugin, so set up only the ones you need.

Google requires every app that accesses these services to be registered, so you'll create your own OAuth app in Google Cloud. You only need to do this once, and you can reuse it for all three plugins.

## Before you start

- You need a Google account that can create a Google Cloud project. On a Google Workspace account, your administrator may need to allow it.
- Check your server URL. If it starts with `https://`, you'll create a **Web application** client. If it starts with `http://`, you'll create a **Desktop app** client. To get an HTTPS address, see [Tailscale HTTPS](../configuration/remote-access.md#tailscale-https).

## 1. Add the plugin

In OpenTeam, open **Marketplace** and choose **Add** on Gmail, Google Calendar, or Google Drive. Keep the plugin's page open. You'll need its **Required provider scopes** in the next step, and on an HTTPS server, its **Authorized redirect URI**.

## 2. Create a Google Cloud app

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Enable the API for each plugin you'll use: **Gmail API**, **Google Calendar API**, or **Google Drive API**.
3. Set up the OAuth consent screen. For a personal Gmail account, choose **External** as the audience and add your Google account as a test user. On a Google Workspace account, you can choose **Internal** instead.
4. Add the scopes listed under **Required provider scopes** on the plugin's page. If you're reusing the app for several plugins, add the scopes for each.
5. Create an OAuth client:
   - **HTTPS server:** choose **Web application**, and add the **Authorized redirect URI** shown on the plugin's page. It looks like `https://<your-server>/api/v0/plugin-oauth/callback`.
   - **HTTP server:** choose **Desktop app**. There's no redirect URI to add.
6. Copy the client ID and client secret.

Google's guide to [creating credentials](https://developers.google.com/workspace/guides/create-credentials) has more detail on each step.

## 3. Connect in OpenTeam

1. On the plugin's page, paste the client ID and secret, then choose **Save credentials and continue**.
2. Sign in:
   - **HTTPS server:** your browser opens. Choose your Google account and approve access. When the page says **Plugin connected**, close the tab and return to OpenTeam.
   - **HTTP server:** choose **Continue to Google**, then choose your account and approve access. Your browser ends on a page that doesn't load; that's expected. Copy the full address from the address bar, paste it into **Paste the browser address here** in OpenTeam, and choose **Complete sign-in**.

   If Google warns that it hasn't verified the app, continue anyway; it's the app you just created.
3. Back on the plugin's page, under **Bot access**, turn on the account for the bots that should use it.

To check the account, open **Manage → Accounts and settings**, choose the account, and run one of these under **Test a tool**:

| Plugin | Tool | Input |
| --- | --- | --- |
| Gmail | `get_profile` | `{}` |
| Calendar | `list_calendars` | `{}` |
| Drive | `list_recent_files` | `{"pageSize":5}` |

Repeat for each plugin. To connect another Google account, choose **Add Another Account**, give it a name, and sign in with that account.

## What bots can do

- **Gmail:** search and read email, create and apply labels, move messages to trash or spam and back, and write drafts. Bots can't send email; they leave drafts for you to review and send.
- **Calendar:** find events, check availability, create, update, or delete events, and respond to invitations. Changes can notify attendees, so review them first.
- **Drive:** find, read, and download files, including comments on Docs, Sheets, and Slides. See who has access to a file, create folders, and create, upload, or copy files. Files over 64 MB can't be read, downloaded, or uploaded.

Bots can only reach what your Google account can.

## Keep the connection working

While an **External** app's publishing status is **Testing**, Google ends sign-ins after seven days and you'll need to sign in again. For a longer-lasting connection, change the publishing status to **In production**. See [Google's token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

If you change your server's address, update the redirect URI in Google Cloud to match.

## Fix common problems

| Problem | What to do |
| --- | --- |
| `redirect_uri_mismatch` | Make sure the client type matches your server: **Web application** for HTTPS, **Desktop app** for HTTP. For a Web application client, compare the redirect URI with the one OpenTeam shows. |
| Access denied or blocked | Check that your account is a test user, the API is enabled, and the scopes are added. Workspace accounts may need administrator approval. |
| Sign-in expires every week | Your app is in **Testing**. See [keep the connection working](#keep-the-connection-working). |

For other connection problems, see [connecting accounts](accounts.md#troubleshooting).
