import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import {
  receiveAutomationWebhook,
  type AutomationWebhookBinding,
} from "../src/automation-webhooks";
const secret = "synthetic-webhook-secret";
const owner = { kind: "bot" as const, id: crypto.randomUUID() };
const send = async (
  source: AutomationWebhookBinding["source"],
  payload: unknown,
  headers: Record<string, string> = {},
  extra: Partial<AutomationWebhookBinding> = {}
) => {
  const raw = JSON.stringify(payload);
  const header =
    source === "linear"
      ? "linear-signature"
      : source === "sentry"
        ? "sentry-hook-signature"
        : "x-pagerduty-signature";
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  const events: any[] = [];
  await receiveAutomationWebhook(
    new Request("https://example.test/hook", {
      method: "POST",
      headers: { [header]: source === "pagerduty" ? `v1=${signature}` : signature, ...headers },
      body: raw,
    }),
    { id: "fixture", source, owner, ...extra },
    secret,
    async (_owner, event) => {
      events.push(event);
    }
  );
  return events;
};
test("Linear, Sentry and PagerDuty verify native signatures and normalize matching events", async () => {
  expect(
    await send(
      "linear",
      {
        webhookTimestamp: Date.now(),
        type: "Issue",
        action: "create",
        data: { id: "issue", teamId: "team", projectId: "project", title: "Fixture" },
      },
      {},
      { teamId: "team" }
    )
  ).toMatchObject([{ source: "linear", kind: "issueCreated", teamId: "team" }]);
  expect(
    await send(
      "sentry",
      { action: "resolved", data: { issue: { id: "issue", project: { id: 12 } } } },
      { "sentry-hook-resource": "issue" }
    )
  ).toMatchObject([{ source: "sentry", kind: "issueResolved", projectId: "12" }]);
  expect(
    await send(
      "pagerduty",
      {
        event: {
          id: "delivery",
          event_type: "incident.triggered",
          data: { service: { id: "service" } },
        },
      },
      {},
      { serviceId: "service" }
    )
  ).toMatchObject([{ source: "pagerduty", kind: "incidentTriggered", serviceId: "service" }]);
  await expect(
    send("linear", {
      webhookTimestamp: Date.now() - 120000,
      type: "Issue",
      action: "create",
      data: {},
    })
  ).rejects.toThrow("Expired");
  await expect(
    send("sentry", { action: "created" }, { "sentry-hook-signature": "wrong" })
  ).rejects.toThrow("signature");
});
test("Teams binds notification secret, tenant, subscription and resource before fetching message data", async () => {
  const binding: AutomationWebhookBinding = {
    id: "fixture",
    source: "microsoftTeams",
    owner,
    tenantId: "tenant",
    teamId: "team",
    subscriptionId: "subscription",
    resource: "teams/team/channels/channel/messages",
  };
  let reads = 0;
  const events: any[] = [];
  const notification = {
    value: [
      {
        clientState: secret,
        tenantId: "tenant",
        subscriptionId: "subscription",
        resource: `${binding.resource}/123`,
        changeType: "created",
      },
    ],
  };
  const invoke = (body: any) =>
    receiveAutomationWebhook(
      new Request("https://example.test/hook", { method: "POST", body: JSON.stringify(body) }),
      binding,
      secret,
      async (_owner, event) => {
        events.push(event);
      },
      Date.now(),
      async (resource) => {
        reads++;
        expect(resource).toEndWith("/123");
        return {
          id: "123",
          body: { content: "Synthetic message" },
          from: { user: { id: "user" } },
          channelIdentity: { channelId: "channel" },
          createdDateTime: "2026-09-14T00:00:00Z",
        };
      }
    );
  expect((await invoke(notification)).status).toBe(200);
  expect(reads).toBe(1);
  expect(events[0]).toMatchObject({
    kind: "message",
    channelId: "channel",
    authenticatedUser: true,
    text: "Synthetic message",
  });
  notification.value[0]!.resource = `${binding.resource}/../../users`;
  await expect(invoke(notification)).rejects.toThrow("resource");
  expect(reads).toBe(1);
  notification.value[0]!.clientState = "wrong";
  await expect(invoke(notification)).rejects.toThrow("notification");
  expect(reads).toBe(1);
  const challenge = await receiveAutomationWebhook(
    new Request("https://example.test/hook?validationToken=opaque-token", { method: "POST" }),
    binding,
    secret,
    async () => {}
  );
  expect(await challenge.text()).toBe("opaque-token");
});
