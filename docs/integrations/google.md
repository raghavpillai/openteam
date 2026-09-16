# Google

Connect Gmail, Google Calendar, and Google Drive so bots can use your mail, events, and files. Set up only the plugins you need.

## Before you start

You need a Google account and permission to configure an OAuth application in a Google Cloud project. A Workspace administrator may need to allow the requested access.

OpenTeam uses bundled connectors for Google's public APIs. Each plugin account needs authorization; connecting Gmail does not connect Calendar or Drive.

## Configure Google access

1. Install the desired plugin in OpenTeam. Open **Manage plugins → Installed**, select its account, and copy **OAuth callback URL**.
2. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project. Enable the API for each plugin you will use: **Gmail API**, **Google Calendar API**, or **Google Drive API**.
3. Configure the OAuth application's consent details and audience. If it is in testing, include the identities you intend to authorize as test users.
4. Add the scopes shown in OpenTeam's **Requested scopes**. When reusing one OAuth client across plugins, include the required scopes for each.
5. Create an OAuth client with application type **Web application**. Under authorized redirect URIs, register each exact OpenTeam callback, including its `connectionId` query parameter.
6. Enter the client ID and required client secret in the OpenTeam account's setup form.

Google's [credential setup guide](https://developers.google.com/workspace/guides/create-credentials) explains its client configuration. Keep the server address stable: changing it can change the callback you need to register.

## Authorize each account

Choose **Save and authorize** in OpenTeam, select the intended Google identity, and review the requested permissions. After connection, test a small read:

| Plugin | Example test |
| --- | --- |
| Gmail | `get_profile` with `{}` |
| Calendar | `list_calendars` with `{}` |
| Drive | `list_recent_files` with `{"pageSize":5}` |

Confirm the account and returned data, then grant the account to the intended bots. Repeat for each plugin. For another identity, add an account, register its callback, and authorize it separately.

## What bots can do

- **Gmail:** find and read mail, organize labels, and prepare drafts and replies. The bundled connector does not send mail.
- **Calendar:** find events, inspect availability, and create or update events. Changes can notify attendees; specify your intent and review the proposed action.
- **Drive:** find files, read supported documents, upload or copy files, and work with supported comments. Some writes are limited to files the OAuth application can access.

A connected account does not bypass its sharing permissions. File extraction can also have format and size limits; ask the bot what it could read when a result is incomplete.

## Fix common problems

For a redirect mismatch, compare the complete callback URL with the registered value. For an access error, check the selected identity, enabled API, requested scopes, and Workspace policy.

If authorization repeatedly expires, inspect the OAuth application's testing or publishing state and reauthorize as needed. For general recovery, use [connection troubleshooting](accounts.md#troubleshooting).
