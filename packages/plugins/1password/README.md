# 1Password

OpenTeam integration with the official 1Password Environments MCP server. Includes
one desktop MCP connection and one OpenTeam-authored workflow skill. The provider
binary is installed and updated by 1Password; OpenTeam does not redistribute it.

## UI setup

1. Update and unlock 1Password on macOS or Linux.
2. Select **Settings → Developer → Integrate with MCP clients** and complete any
   macOS setup prompt. The main window also has **Developer → MCP Server** with an
   enable checkbox. On older versions, first enable **Settings → Labs → MCP
   Server**. The Labs entry was removed in 8.12.34; its absence alone does not mean
   your account lacks access. If Developer has no MCP option, check availability
   with 1Password; a Business admin may also need to enable **Policies → Agentic
   permissions → Local MCP server**.
3. Keep OpenTeam desktop open on that same computer. Install **1Password** from
   **Plugins → Marketplace**, then choose **Connect** and authorize in 1Password.
4. Grant the account and skill to the intended Bots. Use **Account settings → Test
   a tool** to test the discovered tools. Authorization is controlled by 1Password
   and ends when it locks. Reconnect or authenticate after unlocking.

No API key, OAuth client registration, service-account token, or user CLI setup is
required. A browser-only or cloud deployment cannot reach the local app without
its configured OpenTeam desktop host bridge. Windows is not supported by 1Password.

## Capabilities

The official server exposes `authenticate`, `list_environments`,
`create_environment`, `rename_environment`, `list_variables`, `append_variables`,
`list_local_env_files`, and `create_local_env_file`. Tool schemas are discovered
from the installed provider version. Connect authenticates before declaring the
connection ready: unauthenticated `tools/list` alone is not evidence of access.
Background health checks do not authenticate native connections. After 1Password
locks or restarts, unlock it and reconnect from the UI if a tool needs authorization.

If the native provider says the desktop app is not running while it is open,
check for an unfinished macOS setup/administrator prompt. During initial setup,
1Password installs its MCP command before starting its local service. Complete
that prompt, then reconnect. A visible enable checkbox does not prove the local
service has finished starting.

It returns environment metadata, variable **names**, and mount paths, never stored
secret values. It is not a vault item/password retrieval service. Mounts belong to
the user's physical computer and are not automatically available inside Bot
containers. Multiple OpenTeam connection aliases have separate processes and Bot
grants; the account selection and visible accounts remain controlled by 1Password.

The reference Cursor plugin also installs a shell-validation hook. OpenTeam's
package contains the MCP connection and a workflow skill; it does not claim to run
that Cursor-specific hook.

## Implementation

`configuration.runtime: "desktop"` selects the native provider adapter through the
existing authenticated host bridge. The Bot runtime forwards only the connection
ID, provider key, and MCP operation. The desktop resolves the installed vendor
binary. Package commands, environment variables, credentials, and files cannot be
forwarded for execution on the user's computer. Other packaged MCPs continue to
run on the Bot computer. To support another native provider, explicitly add its
adapter and validation rather than adding a general shell endpoint.

Official references: [MCP setup and tools](https://www.1password.dev/environments/mcp-server),
[Cursor plugin](https://github.com/1Password/cursor-plugin),
[current macOS release notes](https://releases.1password.com/mac/stable/).
