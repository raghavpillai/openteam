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

const binding: AutomationWebhookBinding = { id: 'fixture', owner, source: 'slack', secretEnv: 'OPENTEAM_EVENT_FIXTURE', teamId: 'T1234', selfUserId: 'U1234', channelNames: { C1234: 'engineering' } };
const now = Date.now();
const slack = (body: unknown, timestamp = String(Math.floor(now / 1000))) => { const raw = JSON.stringify(body); return new Request('http://localhost/fixture', { method: 'POST', body: raw, headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}` } }); };
test('signed Slack challenges and deliveries enforce age, workspace and fixed owner', async () => {
 const calls: unknown[] = []; const dispatch = async (...args: unknown[]) => { calls.push(args); };
 const challenge = await receiveAutomationWebhook(slack({ type: 'url_verification', challenge: 'fixture' }), binding, secret, dispatch, now);
 expect(await challenge.json()).toEqual({ challenge: 'fixture' }); expect(calls).toHaveLength(0);
 const payload = { event_id: 'Ev123', team_id: 'T1234', event: { type: 'app_mention', channel: 'C1234', text: 'Hello <@U1234>', user: 'U5678' } };
 await receiveAutomationWebhook(slack(payload), binding, secret, dispatch, now);
 expect(calls).toEqual([[owner, expect.objectContaining({ source: 'slack', id: 'Ev123', channel: 'engineering', mention: true, bySelf: false })]]);
 await expect(receiveAutomationWebhook(slack(payload, '1'), binding, secret, dispatch, now)).rejects.toThrow('Expired');
 await expect(receiveAutomationWebhook(slack({ ...payload, team_id: 'OTHER' }), binding, secret, dispatch, now)).rejects.toThrow('workspace');
 const altered = slack(payload); altered.headers.set('x-slack-signature', 'v0=bad'); await expect(receiveAutomationWebhook(altered, binding, secret, dispatch, now)).rejects.toThrow('signature'); expect(calls).toHaveLength(1);
});
test('GitHub signed delivery maps PR and CI events and rejects repository substitution', async () => {
 const calls: any[] = []; const git = { ...binding, source: 'github' as const, repository: 'fixture/repo' };
 const request = (payload: unknown, type: string) => { const raw = JSON.stringify(payload); return new Request('http://localhost/fixture', { method: 'POST', body: raw, headers: { 'x-github-event': type, 'x-github-delivery': 'delivery-123', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } }); };
 const payload = { repository: { full_name: 'fixture/repo' }, sender: { login: 'alice' }, action: 'closed', pull_request: { number: 9, merged: true, head: { ref: 'main' }, user: { login: 'bob' } } };
 await receiveAutomationWebhook(request(payload, 'pull_request'), git, secret, async (_owner, event) => { calls.push(event); });
 expect(calls[0]).toMatchObject({ kind: 'pr-merged', pr: 9, actor: 'alice', prOwner: 'bob', repo: 'fixture/repo' });
 await expect(receiveAutomationWebhook(request({ ...payload, repository: { full_name: 'attacker/repo' } }, 'pull_request'), git, secret, async () => {})).rejects.toThrow('repository');
 await receiveAutomationWebhook(request({ ...payload, pull_request: undefined, action: 'completed', check_suite: { conclusion: 'failure', head_branch: 'main', pull_requests: [{ number: 9 }] } }, 'check_suite'), git, secret, async (_owner, event) => { calls.push(event); });
 expect(calls[1]).toMatchObject({ kind: 'ci-failed', branch: 'main', pr: 9 });
});
