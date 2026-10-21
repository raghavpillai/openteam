# Google

Connect Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, and Google Slides so bots can work with your email, events, files, documents, spreadsheets, and presentations. Each is a separate plugin, so set up only the ones you need.

Google requires every app that accesses these services to be registered, so you'll create your own OAuth app in Google Cloud. You only need to do this once, and you can reuse it for every Google plugin.

## Before you start

- You need a Google account that can create a Google Cloud project. On a Google Workspace account, your administrator may need to allow it.
- Check your server URL. If it starts with `https://`, you'll create a **Web application** client. If it starts with `http://`, you'll create a **Desktop app** client. To get an HTTPS address, see [Tailscale HTTPS](../configuration/remote-access.md#tailscale-https).

## 1. Add the plugin

In OpenTeam, open **Marketplace** and choose **Add** on the Google plugin you want. Keep the plugin's page open. You'll need its **Required provider scopes** in the next step, and on an HTTPS server, its **Authorized redirect URI**.

## 2. Create a Google Cloud app

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Enable the API for each plugin you'll use: **Gmail API**, **Google Calendar API**, **Google Drive API**, **Google Docs API**, **Google Sheets API**, or **Google Slides API**.
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
Installed plugins and their connected accounts are available to all bots.

To check the account, open **Manage → Accounts and settings**, choose the account, and run one of these under **Test a tool**:

| Plugin | Tool | Input |
| --- | --- | --- |
| Gmail | `get_profile` | `{}` |
| Calendar | `list_calendars` | `{}` |
| Drive | `list_recent_files` | `{"pageSize":5}` |
| Docs | `read_document` | `{"documentId":"<id from a document URL>"}` |
| Sheets | `get_spreadsheet` | `{"spreadsheetId":"<id from a spreadsheet URL>"}` |
| Slides | `read_presentation` | `{"presentationId":"<id from a presentation URL>"}` |

Repeat for each plugin. To connect another Google account, choose **Add Another Account**, give it a name, and sign in with that account.

## What bots can do

- **Gmail:** search and read email, create and apply labels, move messages to trash or spam and back, and write, edit and delete Gmail drafts. To send, a bot posts a draft card in its chat; when you choose **Send**, OpenTeam sends it from your Gmail address, threaded under the original for replies. The card's **From** menu lists your verified **Send mail as** addresses, and your Gmail signature is added under the message. See [Approve before it sends](email.md#approve-before-it-sends) for the approval menu. Bots can't send Gmail any other way.
- **Calendar:** find events, check availability, create, update, or delete events, and respond to invitations. Bots can set an event's reminders, remove them, or use your calendar's default reminders. On Google Workspace accounts, they can also set your working location, including an office building, floor, and desk. Unless you name other dates, event lists cover the next seven days. Changes can notify attendees, so review them first.
- **Drive:** search for files, browse folders, and read Docs, Sheets, Slides, and text files. Bots can download files or export Google files as PDF and other formats, create folders and files (including turning Markdown into a Google Doc or CSV into a Google Sheet), replace a file's text, and move, rename, copy, or trash files. They can see who has access, share a file with a person, group, or domain you name, and read, add, reply to, or resolve comments. Google limits changes to the files and folders bots created through this plugin, so bots can't edit, move, share, trash, or comment on your other files, or add files to folders they didn't create. Trashed files stay recoverable for about 30 days, and bots can't delete anything permanently. Downloads and exports are limited to 10 MB, and other file operations to 64 MB.

- **Docs:** read a document's structure and text, create documents, and edit them in place: insert, replace, and delete text, apply text and paragraph styles, build lists and tables, and add images, page breaks, headers, and footers.
- **Sheets:** read ranges and spreadsheet structure, create spreadsheets, write, append, and clear values, and manage tabs, rows, and columns. Bots can also format cells, add charts, filters, validation, conditional formatting, and named or protected ranges, and sort or find and replace. This is what lets a bot keep a spreadsheet up to date over time.
- **Slides:** read presentations and slide layouts, create presentations, add and arrange slides, and place and style text, shapes, lines, images, tables, and grids of cards. Bots can render a slide as an image to check how it looks.

Docs, Sheets, and Slides can change any file your Google account can edit, not only files a bot created. Their tools take a file's ID, so connect Drive too if you want bots to find files by name or put new files in a folder.

Bots can only reach what your Google account can.

## Keep the connection working

While an **External** app's publishing status is **Testing**, Google expires refresh tokens after seven days and you'll need to sign in again. For a longer-lasting connection, configure the app for **In production**, meeting Google's applicable requirements, then sign in again to obtain a new grant. Production grants can still be revoked, for example after access is removed or a Gmail account's password changes. See [Google's token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

OpenTeam renews short-lived access tokens automatically. If Google rejects the refresh token, the affected account shows **Sign-in needed**. Select **Sign in** for that account and complete authorization. Restarting the connector cannot repair a revoked grant. Other connected accounts keep their own credentials.

If you change your server's address, update the redirect URI in Google Cloud to match.

## Fix common problems

| Problem | What to do |
| --- | --- |
| `redirect_uri_mismatch` | Make sure the client type matches your server: **Web application** for HTTPS, **Desktop app** for HTTP. For a Web application client, compare the redirect URI with the one OpenTeam shows. |
| Access denied or blocked | Check that your account is a test user, the API is enabled, and the scopes are added. Workspace accounts may need administrator approval. |
| Sign-in expires every week | Check whether your app is in **Testing**. See [keep the connection working](#keep-the-connection-working). |
| Authorization expired or was revoked | Select **Sign in** for the affected account. If an older installation shows a connection error, use **Reauthorize** in that account's settings. |

For other connection problems, see [connecting accounts](accounts.md#troubleshooting).
