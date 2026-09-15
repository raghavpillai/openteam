# Automation event subscriptions

Server settings → Automation event subscriptions stores provider configuration, plaintext management tokens and signing secrets in PostgreSQL, matching the on-prem configuration model. Public responses expose only key-presence flags. A subscription belongs to one bot or group and uses a server-generated callback `/api/v0/automation-hooks/<id>` under the configured public HTTPS server URL.

| Provider | Setup | Runtime behavior |
|---|---|---|
| GitHub | Repository, management token, chosen signing secret | Creates/updates repository webhooks; verifies raw-body signatures and repository binding |
| Slack | App ID, team ID, app signing secret, app configuration token | Preserves and updates the app manifest's event subscriptions; validates Slack signatures and timestamp window |
| Linear | Team ID, optional organization ID, management token, signing secret | Creates Issue/Cycle webhook; verifies signature and signed timestamp |
| Sentry | Custom integration slug, optional organization ID, client secret, management token | Updates integration callback and issue events; verifies native signatures |
| PagerDuty | Service ID and management token | Creates subscription and stores the signing secret returned only at creation; verifies v3 delivery signatures |
| Teams | Tenant ID, team ID, `teams/TEAM/channels/CHANNEL/messages` resource, Graph token, chosen client state | Creates basic notifications; validates callback challenge, client state, tenant, subscription and resource; fetches message data with Graph authorization |
| Generic webhook | Chosen signing secret | Accepts the normalized event contract with HMAC-SHA256 verification |

Saving this server setting provisions the remote binding where supported. Saving an agent's listener attaches local matching and dispatch to its owner's configured binding; it cannot provision an account for which no management token/public callback is configured. Slack scope changes can require reinstalling the app. Teams tokens need subscription management and message-read permissions; these are operator-provided management tokens, not a hosted identity broker.

Graph subscriptions renew before expiry, and an expired/deleted subscription returning 404 can be recreated. Concurrent setup attempts are serialized by database compare-and-swap. If a creation response is lost, the binding becomes `uncertain` and cannot be blindly reconnected: inspect the provider's exact callback before replacing it. Only one local binding can own a Slack/Sentry app's callback. Updating API keys preserves the pinned owner and target; changing a target requires replacing the subscription.

Disconnect disables local ingress before removing the remote subscription. Slack and Sentry share app-level settings, so local disconnection does not delete their whole provider apps; the settings response explains the remaining callback configuration. Legacy file-configured Slack/GitHub/generic ingress remains available for existing deployments.

Protocol fixtures and PostgreSQL tests cover creation, signed delivery, validation, renewal, revocation, concurrent setup, and ambiguous-response replay prevention. No real external provider subscriptions were created during the parity implementation.
