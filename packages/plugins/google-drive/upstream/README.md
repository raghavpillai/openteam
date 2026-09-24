# Google Drive

Cursor plugin that connects agents to [Google Drive](https://drive.google.com) through Google's remote [Model Context Protocol](https://modelcontextprotocol.io/) server.

Search Drive, read file metadata and contents, create or update files, and manage sharing.

## Install

1. Open **Cursor Settings → Plugins**.
2. Search for **Google Drive**.
3. Click **Install**, then complete the Google sign-in prompt.

Or run `/add-plugin google-drive` in chat.

## MCP

```json
{
  "mcpServers": {
    "google-drive": {
      "type": "http",
      "url": "https://drivemcp.googleapis.com/mcp/v1"
    }
  }
}
```

Auth is OAuth 2.0 against Google. Cursor prompts for Google sign-in when the plugin connects.

## Docs

- Google MCP setup: https://developers.google.com/workspace/drive/api/guides/configure-mcp-server
- Workspace MCP overview: https://developers.google.com/workspace/guides/configure-mcp-servers

Logo is the official Google Drive product icon, placed on a white tile with padding so it reads well in the Cursor UI:
https://www.gstatic.com/images/branding/productlogos/drive_2026/v1/192px.svg

## License

MIT
