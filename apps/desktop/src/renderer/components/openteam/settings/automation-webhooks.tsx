import { useEffect, useState } from "react";
import {
  AUTOMATION_WEBHOOK_PROVIDERS,
  type AutomationWebhookInput,
  type AutomationWebhookView,
} from "@openteam/contracts/automation-webhooks";
import { api } from "../../../client/openteam-api";
import { SectionLabel, SettingsGroup } from "./ui";
const fields: Record<string, string[]> = {
  github: ["repository"],
  slack: ["appId", "teamId", "selfUserId"],
  linear: ["teamId", "organizationId"],
  sentry: ["appSlug", "organizationId"],
  pagerduty: ["serviceId"],
  microsoftTeams: ["tenantId", "teamId", "resource"],
  webhook: [],
};
export function AutomationWebhookSettings() {
  const [editingId, setEditingId] = useState<string | undefined>();
  const [rows, setRows] = useState<AutomationWebhookView[]>([]);
  const [source, setSource] = useState<AutomationWebhookInput["source"]>("github");
  const [ownerKind, setOwnerKind] = useState<"bot" | "group">("bot");
  const [ownerId, setOwnerId] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [configuration, setConfiguration] = useState<Record<string, string>>({});
  const [signingSecret, setSecret] = useState("");
  const [apiToken, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    api
      .automationWebhooks()
      .then(setRows)
      .catch(() => setMessage("Could not load event subscriptions"));
  }, []);
  const perform = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      const result = (await work()) as any;
      setRows(await api.automationWebhooks());
      if (result?.statusMessage) setMessage(result.statusMessage);
      else if (result?.notice) setMessage(result.notice);
      else setMessage("Saved");
    } catch {
      setMessage(
        "Subscription operation failed. Check the connection, permissions, and provider configuration."
      );
    } finally {
      setBusy(false);
    }
  };
  const style = "rounded border bg-background p-2 text-xs";
  const button = "rounded bg-foreground/10 px-3 py-2 text-xs disabled:opacity-40";
  return (
    <>
      <SectionLabel>Automation event subscriptions</SectionLabel>
      <SettingsGroup>
        <div className="space-y-3 py-3 text-sm">
          <p>
            Connect provider events to a bot or group. Matching routines receive signed events
            automatically. This server must have a public HTTPS callback URL.
          </p>
          {rows.map((row) => (
            <div className="space-y-1 rounded border p-2" key={row.id}>
              <div>
                {row.source} · {row.status} · {row.ownerKind} {row.ownerId}
              </div>
              <div className="break-all text-xs">{row.callbackUrl}</div>
              {row.statusMessage && <p className="text-xs">{row.statusMessage}</p>}
              <div className="flex gap-2">
                <button
                  disabled={busy || row.status === "connecting" || row.status === "uncertain"}
                  className={button}
                  onClick={() => void perform(() => api.connectAutomationWebhook(row.id))}
                >
                  Reconnect
                </button>
                <button
                  disabled={busy || row.status === "connecting" || row.status === "uncertain"}
                  className={button}
                  onClick={() => {
                    setEditingId(row.id);
                    setSource(row.source as typeof source);
                    setOwnerKind(row.ownerKind as typeof ownerKind);
                    setOwnerId(row.ownerId);
                    setConfiguration(row.configuration);
                    setPublicUrl(
                      row.callbackUrl.replace(/\/api\/v0\/automation-hooks\/[^/]+$/, "")
                    );
                    setSecret("");
                    setToken("");
                  }}
                >
                  Update keys
                </button>
                <button
                  disabled={busy}
                  className={button}
                  onClick={() => void perform(() => api.removeAutomationWebhook(row.id))}
                >
                  Disconnect
                </button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Event provider"
              className={style}
              value={source}
              onChange={(e) => {
                setSource(e.target.value as typeof source);
                setConfiguration({});
              }}
            >
              {AUTOMATION_WEBHOOK_PROVIDERS.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <select
              aria-label="Routine owner kind"
              className={style}
              value={ownerKind}
              onChange={(e) => setOwnerKind(e.target.value as typeof ownerKind)}
            >
              <option value="bot">Bot</option>
              <option value="group">Group</option>
            </select>
            <input
              aria-label="Bot or group ID"
              className={style}
              value={ownerId}
              placeholder="Bot or group ID"
              onChange={(e) => setOwnerId(e.target.value)}
            />
          </div>
          <input
            aria-label="Public server URL"
            className={`${style} w-full`}
            value={publicUrl}
            placeholder="Public server URL, https://openteam.example.com"
            onChange={(e) => setPublicUrl(e.target.value)}
          />
          {fields[source]!.map((field) => (
            <input
              key={field}
              aria-label={field}
              className={`${style} mr-2`}
              value={configuration[field] ?? ""}
              placeholder={
                field === "resource" ? "teams/TEAM_ID/channels/CHANNEL_ID/messages" : field
              }
              onChange={(e) => setConfiguration({ ...configuration, [field]: e.target.value })}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            {source !== "pagerduty" && (
              <input
                aria-label="Webhook signing secret"
                type="password"
                autoComplete="new-password"
                className={style}
                value={signingSecret}
                placeholder="Signing secret"
                onChange={(e) => setSecret(e.target.value)}
              />
            )}{" "}
            {source !== "webhook" && (
              <input
                aria-label="Provider management token"
                type="password"
                autoComplete="new-password"
                className={style}
                value={apiToken}
                placeholder="Provider management token"
                onChange={(e) => setToken(e.target.value)}
              />
            )}
          </div>
          <p className="text-xs text-foreground-secondary">
            Slack uses its app signing secret and an app configuration token. Sentry uses its
            integration client secret. PagerDuty generates its signing secret. Other providers use a
            secret you choose. Management tokens need subscription permissions; Teams also needs
            message-read permissions. Keys are stored in this server's database.
          </p>
          <button
            className={button}
            disabled={
              busy ||
              !ownerId ||
              !publicUrl ||
              (!editingId && source !== "pagerduty" && signingSecret.length < 16) ||
              (!editingId && source !== "webhook" && !apiToken)
            }
            onClick={() =>
              void perform(async () => {
                const result = await api.saveAutomationWebhook({
                  id: editingId,
                  source,
                  ownerKind,
                  ownerId,
                  publicUrl,
                  configuration,
                  signingSecret: signingSecret || undefined,
                  apiToken: apiToken || undefined,
                });
                setSecret("");
                setToken("");
                setEditingId(undefined);
                return result;
              })
            }
          >
            {editingId ? "Save updated keys" : "Save and connect"}
          </button>
          {editingId && (
            <button
              className={button}
              onClick={() => {
                setEditingId(undefined);
                setSecret("");
                setToken("");
              }}
            >
              Cancel update
            </button>
          )}
          {message && (
            <p role="status" className="text-xs">
              {message}
            </p>
          )}
        </div>
      </SettingsGroup>
    </>
  );
}
