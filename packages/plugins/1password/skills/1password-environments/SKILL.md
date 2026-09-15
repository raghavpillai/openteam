---
name: 1password-environments
description: Manage developer environments through the local 1Password MCP server, verify mounts, and keep stored secret values out of conversation.
---

# 1Password Environments

Use the enabled 1Password connection and discover its current tool schemas. This
is the official local developer-environments MCP, not a general password-vault
reader. Stored secret values cannot be retrieved with these tools.

The MCP process runs on the user's computer through OpenTeam desktop. File paths
passed to it refer to that computer, not the Bot's Linux computer. Local mounts
work on macOS and Linux; Windows is unsupported. Never silently copy a mounted
secret file into the Bot computer or claim it is mounted there.

Authenticate with `authenticate` when needed. Use its returned account IDs rather
than guessing them. Respect the account and environment the user requested; do
not enumerate unrelated accounts or vault items. 1Password presents its own
authorization prompts; ask the user to unlock or approve in that app if needed.
Each connection has its own MCP process and Bot grants, but account visibility is
determined by the 1Password authorization, not by the OpenTeam account alias.

For an existing environment, use `list_environments` in the intended account and
match its name exactly. Resolve ambiguous or duplicate names before changing
anything. `list_variables` returns variable names; summarize names only.

For a requested new environment, check for the requested name, then call
`create_environment`. For variable additions or updates explicitly requested by
the user, call `append_variables` with the schema's required fields. Set
`concealed: true` for credentials. Prefer the 1Password UI to enter new secret
values; never ask the user to paste them into chat.

When the user requests importing a local .env file, first confirm its path is on
the same computer as 1Password. Prefer importing through the 1Password UI so values
do not enter model context. Resolve the target environment and verify the variable
names after import. If local mounting is part of the request, inspect
`list_local_env_files`, create the mount at the requested absolute path with
`create_local_env_file`, and verify it with `list_local_env_files` again. Do not
overwrite an existing regular file or remove tracked files without resolving the
conflict with the user. Do not report completion while mounting is unresolved.

A mounted .env is a FIFO, not a regular file. Never read it to verify it, which
could reveal credentials or block waiting for authorization. Use mount metadata
and, when needed, a local `test -p` check through the authorized host Shell tool.
Run consuming applications on that same local computer. OpenTeam does not install
Cursor's beforeShellExecution hook; verify relevant mounts before starting a
command that depends on them.

If authentication fails after a previously successful connection, unlock 1Password
and retry authentication. If setup is unavailable, direct the user to the plugin's
UI setup instructions; do not invent an HTTP endpoint or replace this connection
with a service-account vault reader.
