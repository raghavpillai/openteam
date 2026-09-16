# Approvals and privacy

Choose which accounts and computers a bot can use, and review actions that need your permission.

## Review a requested action

When OpenTeam presents a review request, check the account, target, and proposed change. Choose **Allow once** to approve that action without changing the tool's standing policy, or reject it and explain what the bot should do instead.

Approval does not undo a change after it happens. If a task stops or a service reports an uncertain result, check the destination before asking for the same write again.

## Set plugin access

Installing a plugin, connecting an account, and granting it to a bot are separate steps. Grant only the accounts that bot needs.

In the plugin's tool policies:

| Policy | Effect |
| --- | --- |
| Allow | Permits the tool without a manual approval prompt, subject to other access controls |
| Ask first | Requests approval before execution |
| Deny | Blocks the tool |

A disabled tool is hidden from bots. Workspace restrictions take precedence over a bot's preferences. These settings do not grant permissions that the external account lacks.

## Control local computer access

Use **Settings → Computer** for access to your physical computer. **Ask every time**, **Always allow**, and **Never allow** control local execution permission.

Desktop **Settings → General** also contains auto-review and its rules. Auto-review can handle eligible review decisions automatically; an “always allow” setting is not a promise that every action will run. The requested capability and other checks still matter.

## Know where data goes

Conversations, files, and settings are stored on your server. The model provider receives the context needed to run a task, and connected services receive requests made through their tools. Self-hosting the server does not make those external services local.

Bots share workspace files, and a bot's memory can carry across conversations. Separate bot screens are not separate user accounts or isolated storage.

Keep account secrets in setup and connection forms. Browser logins should happen in the site's login form. Treat server backups and saved browser sessions as sensitive data.

## Disconnect access

Remove a bot's account grant to stop it using that plugin account. Disconnect or remove the account when you no longer need it, and revoke access at the provider if you also want to cancel the provider-side authorization. See [plugins](../usage/plugins.md#updates-disconnection-and-removal).
