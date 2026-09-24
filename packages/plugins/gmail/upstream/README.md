# Gmail

Cursor plugin that connects agents to [Gmail](https://mail.google.com) through Google's remote [Model Context Protocol](https://modelcontextprotocol.io/) server.

Search threads, read messages, manage labels and drafts, and compose mail in the signed-in Gmail account.

## Install

1. Open **Cursor Settings → Plugins**.
2. Search for **Gmail**.
3. Click **Install**, then complete the Google sign-in prompt.

Or run `/add-plugin gmail` in chat.

## MCP

```json
{
  "mcpServers": {
    "gmail": {
      "type": "http",
      "url": "https://gmailmcp.googleapis.com/mcp/v1"
    }
  }
}
```

Auth is OAuth 2.0 against Google. Cursor prompts for Google sign-in when the plugin connects.

## Docs

- Google MCP setup: https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server
- Workspace MCP overview: https://developers.google.com/workspace/guides/configure-mcp-servers

Logo is the official Gmail product icon, placed on a white tile with padding so it reads well in the Cursor UI:
https://www.gstatic.com/images/branding/productlogos/gmail_2026/v1/192px.svg

## License

MIT
