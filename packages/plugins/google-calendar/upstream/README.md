# Google Calendar

Cursor plugin that connects agents to [Google Calendar](https://calendar.google.com) through Google's remote [Model Context Protocol](https://modelcontextprotocol.io/) server.

List calendars, search and inspect events, suggest times, and create, update, or respond to meetings.

## Install

1. Open **Cursor Settings → Plugins**.
2. Search for **Google Calendar**.
3. Click **Install**, then complete the Google sign-in prompt.

Or run `/add-plugin google-calendar` in chat.

## MCP

```json
{
  "mcpServers": {
    "google-calendar": {
      "type": "http",
      "url": "https://calendarmcp.googleapis.com/mcp/v1"
    }
  }
}
```

Auth is OAuth 2.0 against Google. Cursor prompts for Google sign-in when the plugin connects.

## Docs

- Google MCP setup: https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server
- Workspace MCP overview: https://developers.google.com/workspace/guides/configure-mcp-servers

Logo is the official Google Calendar product icon, placed on a white tile with padding so it reads well in the Cursor UI:
https://www.gstatic.com/images/branding/productlogos/calendar_2026/v1/192px.svg

## License

MIT
