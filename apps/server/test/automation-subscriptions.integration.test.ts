import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { createHmac } from "node:crypto";
import { AutomationWebhooksService } from "../src/services/automation-webhooks";
const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!url)(
  "subscriptions persist private keys, provision remote callbacks, renew Graph, and revoke delivery",
  async () => {
    const db = createPrismaClient(url!);
    const botId = crypto.randomUUID();
    const seen: any[] = [];
    const dispatched: any[] = [];
    const ids: string[] = [];
    const service = new AutomationWebhooksService(
      db,
      async (owner, event) => {
        dispatched.push({ owner, event });
      },
      (async (input: any, init: any) => {
        const url = String(input);
        const body = init.body ? JSON.parse(init.body) : undefined;
        seen.push({ url, method: init.method, body });
        if (url.includes("api.github.com"))
          return init.method === "DELETE"
            ? new Response(null, { status: 204 })
            : Response.json({ id: 123 });
        if (url.includes("api.pagerduty.com"))
          return Response.json({
            webhook_subscription: {
              id: "PD123",
              delivery_method: { secret: "provider-generated-signing-secret" },
            },
          });
        if (url.endsWith("/subscriptions") && init.method === "POST") {
          expect(body.includeResourceData).toBe(false);
          expect(body.clientState).toBe("fixture-signing-secret");
          const id = body.notificationUrl.split("/").at(-1);
          expect(
            await (await service.receive(
              id,
              new Request(body.notificationUrl + "?validationToken=fixture-validation", {
                method: "POST",
              })
            ))!.text()
          ).toBe("fixture-validation");
          return Response.json({ id: "graph-subscription" });
        }
        if (url.includes("/subscriptions/")) return Response.json({ id: "graph-subscription" });
        throw new Error("Unexpected provider operation");
      }) as typeof fetch
    );
    try {
      await db.bot.create({
        data: { id: botId, name: "Event fixture", defaultDirectory: "/tmp", status: "active" },
      });
      const base = {
        ownerKind: "bot" as const,
        ownerId: botId,
        publicUrl: "https://fixture.example.test",
        signingSecret: "fixture-signing-secret",
        apiToken: "fixture-provider-token",
      };
      const github = await service.save({
        ...base,
        source: "github",
        configuration: { repository: "fixture/repo" },
      });
      ids.push(github.id);
      expect(github.status).toBe("connected");
      expect(github.remoteId).toBe("123");
      expect(JSON.stringify(await service.list())).not.toContain(base.apiToken);
      expect(JSON.stringify(await service.list())).not.toContain(base.signingSecret);
      const payload = JSON.stringify({
        repository: { full_name: "fixture/repo" },
        action: "opened",
        pull_request: { number: 2 },
        sender: { login: "fixture" },
      });
      const response = await service.receive(
        github.id,
        new Request(github.callbackUrl, {
          method: "POST",
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": "fixture-event",
            "x-hub-signature-256": `sha256=${createHmac("sha256", base.signingSecret).update(payload).digest("hex")}`,
          },
          body: payload,
        })
      );
      expect(response!.status).toBe(200);
      expect(dispatched).toMatchObject([
        { owner: { id: botId }, event: { kind: "pr-opened", pr: 2 } },
      ]);
      await service.connect(github.id);
      expect(seen.at(-1).method).toBe("PATCH");
      const pagerduty = await service.save({
        ...base,
        source: "pagerduty",
        configuration: { serviceId: "SERVICE" },
      });
      ids.push(pagerduty.id);
      expect(
        (await db.automationWebhook.findUniqueOrThrow({ where: { id: pagerduty.id } }))
          .signingSecret
      ).toBe("provider-generated-signing-secret");
      expect(seen.at(-1).body.webhook_subscription.delivery_method.secret).toBeUndefined();
      const graph = await service.save({
        ...base,
        source: "microsoftTeams",
        configuration: {
          tenantId: crypto.randomUUID(),
          teamId: "team",
          resource: "teams/team/channels/channel/messages",
        },
      });
      ids.push(graph.id);
      expect(graph.status).toBe("connected");
      await db.automationWebhook.update({
        where: { id: graph.id },
        data: { expiresAt: new Date() },
      });
      await service.renew();
      expect(seen.at(-1).method).toBe("PATCH");
      expect(seen.at(-1).body.expirationDateTime).toBeString();
      await service.remove(github.id);
      expect(
        await service.receive(github.id, new Request(github.callbackUrl, { method: "POST" }))
      ).toBeNull();
      expect(seen.at(-1).method).toBe("DELETE");
    } finally {
      await db.automationWebhook.deleteMany({ where: { ownerId: botId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
    }
  }
);

test.skipIf(!url)(
  "subscription creation is exclusive and an uncertain write cannot be blindly replayed",
  async () => {
    const db = createPrismaClient(url!);
    const botId = crypto.randomUUID();
    const id = crypto.randomUUID();
    let writes = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = {
      id,
      source: "github",
      ownerKind: "bot",
      ownerId: botId,
      configuration: { repository: "fixture/repo" },
      publicUrl: "https://fixture.example.test",
      signingSecret: "fixture-signing-secret",
      apiToken: "fixture-provider-token",
    };
    const service = new AutomationWebhooksService(db, async () => {}, (async () => {
      writes++;
      entered();
      await pending;
      throw new Error("Response lost after provider committed");
    }) as unknown as typeof fetch);
    try {
      await db.bot.create({
        data: {
          id: botId,
          name: "Concurrent subscription fixture",
          defaultDirectory: "/tmp",
          status: "active",
        },
      });
      const first = service.save(input);
      await started;
      expect((await service.connect(id)).status).toBe("connecting");
      expect(writes).toBe(1);
      await expect(service.save(input)).rejects.toThrow("in progress");
      release();
      expect((await first).status).toBe("uncertain");
      expect((await service.connect(id)).status).toBe("uncertain");
      expect(writes).toBe(1);
      await expect(
        service.save({
          ...input,
          configuration: { repository: "fixture/repo", apiKey: "must-never-be-metadata" },
        })
      ).rejects.toThrow("Unexpected");
    } finally {
      release();
      await db.automationWebhook.deleteMany({ where: { ownerId: botId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
    }
  }
);
