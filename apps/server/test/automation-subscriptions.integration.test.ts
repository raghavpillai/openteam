import { expect } from "bun:test";
import { createHmac } from "node:crypto";
import { AutomationWebhooksService } from "../src/services/automation-webhooks";
import { dbIt } from "./harness";

const base = (ownerId: string) => ({ ownerKind: "bot" as const, ownerId, publicUrl: "https://fixture.example.test", signingSecret: "fixture-signing-secret", apiToken: "fixture-provider-token" });

dbIt("subscriptions persist private keys, provision remote callbacks, renew Graph, and revoke delivery", async h => {
  const bot = await h.bot("Event fixture", {}, { dm: false });
  h.onClose(() => h.db.automationWebhook.deleteMany({ where: { ownerId: bot.id } }));
  const seen: any[] = [], dispatched: any[] = [];
  const service: AutomationWebhooksService = new AutomationWebhooksService(h.db, async (owner, event) => { dispatched.push({ owner, event }); }, (async (input: any, init: any) => {
    const url = String(input), body = init.body ? JSON.parse(init.body) : undefined;
    seen.push({ url, method: init.method, body });
    if (url.includes("api.github.com")) return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: 123 });
    if (url.includes("api.pagerduty.com")) return Response.json({ webhook_subscription: { id: "PD123", delivery_method: { secret: "provider-generated-signing-secret" } } });
    if (url.endsWith("/subscriptions") && init.method === "POST") {
      expect(body).toMatchObject({ includeResourceData: false, clientState: "fixture-signing-secret" });
      const validation = await service.receive(body.notificationUrl.split("/").at(-1), new Request(body.notificationUrl + "?validationToken=fixture-validation", { method: "POST" }));
      expect(await validation!.text()).toBe("fixture-validation");
      return Response.json({ id: "graph-subscription" });
    }
    if (url.includes("/subscriptions/")) return Response.json({ id: "graph-subscription" });
    throw new Error("Unexpected provider operation");
  }) as typeof fetch);
  const input = base(bot.id);
  const github = await service.save({ ...input, source: "github", configuration: { repository: "fixture/repo" } });
  expect(github).toMatchObject({ status: "connected", remoteId: "123" });
  const listed = JSON.stringify(await service.list());
  expect(listed).not.toContain(input.apiToken);
  expect(listed).not.toContain(input.signingSecret);
  const payload = JSON.stringify({ repository: { full_name: "fixture/repo" }, action: "opened", pull_request: { number: 2 }, sender: { login: "fixture" } });
  const response = await service.receive(github.id, new Request(github.callbackUrl, { method: "POST", body: payload, headers: {
    "x-github-event": "pull_request", "x-github-delivery": "fixture-event", "x-hub-signature-256": `sha256=${createHmac("sha256", input.signingSecret).update(payload).digest("hex")}`,
  } }));
  expect(response!.status).toBe(200);
  expect(dispatched).toMatchObject([{ owner: { id: bot.id }, event: { kind: "pr-opened", pr: 2 } }]);
  await service.connect(github.id);
  expect(seen.at(-1).method).toBe("PATCH");
  const pagerduty = await service.save({ ...input, source: "pagerduty", configuration: { serviceId: "SERVICE" } });
  expect((await h.db.automationWebhook.findUniqueOrThrow({ where: { id: pagerduty.id } })).signingSecret).toBe("provider-generated-signing-secret");
  expect(seen.at(-1).body.webhook_subscription.delivery_method.secret).toBeUndefined();
  const graph = await service.save({ ...input, source: "microsoftTeams", configuration: { tenantId: crypto.randomUUID(), teamId: "team", resource: "teams/team/channels/channel/messages" } });
  expect(graph.status).toBe("connected");
  await h.db.automationWebhook.update({ where: { id: graph.id }, data: { expiresAt: new Date() } });
  await service.renew();
  expect(seen.at(-1).method).toBe("PATCH");
  expect(seen.at(-1).body.expirationDateTime).toBeString();
  await service.remove(github.id);
  expect(await service.receive(github.id, new Request(github.callbackUrl, { method: "POST" }))).toBeNull();
  expect(seen.at(-1).method).toBe("DELETE");
});

dbIt("subscription creation is exclusive and an uncertain write cannot be blindly replayed", async h => {
  const bot = await h.bot("Concurrent subscription fixture", {}, { dm: false });
  h.onClose(() => h.db.automationWebhook.deleteMany({ where: { ownerId: bot.id } }));
  const id = crypto.randomUUID(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let writes = 0;
  const input = { id, source: "github", configuration: { repository: "fixture/repo" }, ...base(bot.id) };
  const service = new AutomationWebhooksService(h.db, async () => {}, (async () => {
    writes++; entered.resolve(); await release.promise;
    throw new Error("Response lost after provider committed");
  }) as unknown as typeof fetch);
  try {
    const first = service.save(input);
    await entered.promise;
    expect((await service.connect(id)).status).toBe("connecting");
    await expect(service.save(input)).rejects.toThrow("in progress");
    release.resolve();
    expect((await first).status).toBe("uncertain");
    expect((await service.connect(id)).status).toBe("uncertain");
    expect(writes).toBe(1);
    await expect(service.save({ ...input, configuration: { repository: "fixture/repo", apiKey: "must-never-be-metadata" } })).rejects.toThrow("Unexpected");
  } finally { release.resolve(); }
});
