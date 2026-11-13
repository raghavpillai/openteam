# Privacy and connected services

Connected tools and registered computers run bot actions directly, except that outgoing email, Slack messages and texts wait in a card for you to send by default; see [what bots do without asking](../usage/plugins.md#what-bots-do-without-asking). All bots can use installed plugins and their connected accounts. Remove or disconnect an account or computer to stop its use.

## Where your data goes

- **Your server** stores your conversations, files, memory, and most settings. Device preferences stay on each device. The iPhone app also keeps a copy of your conversations and drafts on the phone until you sign out.
- **Your model provider** receives what the bot needs to work on each task, including messages and file contents.
- **Connected services** receive the requests bots make through plugins.
- **Your web search, web fetch, and transcription providers** receive search queries, the addresses of pages bots fetch, and voice recordings.
- **Map and place services** receive [place searches, route coordinates, map display requests, and photo requests](../integrations/maps.md#privacy-and-map-display), depending on the plugin and client in use.
- **Apple** delivers iPhone alerts, so it receives each alert's title and a preview of up to 140 characters of the message.
- **GitHub** is contacted when the desktop app and the `openteam` CLI check for updates, and **openteam.so** when the iPhone app does.

Self-hosting keeps your data on your server, but these services still see what's sent to them. To keep model requests local too, use your [own model server](models.md#use-your-own-model-server).

## Secrets and backups

Enter passwords in website sign-in forms and tokens in plugin setup forms. Passwords and codes a bot reads from 1Password appear in its conversation, so your model provider sees them too. Backups include connected-account credentials and website sign-ins.
