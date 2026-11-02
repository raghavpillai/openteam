import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { PluginEventPoller, parsePollResult } from "../src/services/plugin/events";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

test("poll results accept MCP text or structured content and surface tool errors", () => {
  expect(parsePollResult(text({ events: [{ id: "1" }], cursor: { uid: 2 } }))).toEqual({
    events: [{ id: "1" }],
    cursor: { uid: 2 },
  });
  expect(parsePollResult({ structuredContent: { events: [] } })).toEqual({
    events: [],
    cursor: null,
  });
  expect(() =>
    parsePollResult({ isError: true, content: [{ type: "text", text: "IMAP login failed" }] })
  ).toThrow("IMAP login failed");
  expect(() => parsePollResult(text({ cursor: 1 }))).toThrow("no events list");
  expect(() => parsePollResult({ content: [{ type: "text", text: "not json" }] })).toThrow(
    "unreadable"
  );
});

test("a failed database read skips the poll pass instead of rejecting", async () => {
  const outage = { pluginConnection: { findMany: () => Promise.reject(new Error("Connection terminated unexpectedly")) } };
  const poller = new PluginEventPoller(
    outage as never,
    async () => undefined,
    async () => undefined
  );
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    await expect(poller.pollDue()).resolves.toBeUndefined();
  } finally {
    console.warn = warn;
  }
  expect(warnings).toEqual(["Plugin event poll failed: Connection terminated unexpectedly"]);
});

test("declared event polls run on their interval, force the manifest source, and save the cursor after dispatch", async () => {
  if (!url) return;
  const prisma = createPrismaClient(url);
  const pluginKey = `events-${crypto.randomUUID().slice(0, 8)}`;
  let now = new Date("2026-10-14T12:00:00Z");
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const dispatched: unknown[] = [];
  let reply: unknown = text({
    events: [
      {
        id: "mail-1",
        source: "webhook",
        kind: "received",
        text: "Subject: Hi",
        channel: "bot@example.com",
      },
    ],
    cursor: { mailbox: "bot@example.com", uidValidity: "7", uidNext: 43 },
  });
  const poller = new PluginEventPoller(
    prisma,
    async (_connection, tool, args) => {
      calls.push({ tool, args });
      return reply;
    },
    async (event) => {
      dispatched.push(event);
    },
    () => now
  );
  try {
    const installation = await prisma.pluginInstallation.create({
      data: {
        pluginKey,
        version: "1.0.0",
        name: "Events fixture",
        publisher: "Test",
        manifest: {
          key: pluginKey,
          name: "Events fixture",
          skills: [],
          connections: [
            {
              key: "mail",
              transport: "stdio",
              events: { pollTool: "poll_new_mail", source: "email", intervalSeconds: 60 },
            },
            { key: "plain", transport: "stdio" },
          ],
        },
      },
    });
    const connection = await prisma.pluginConnection.create({
      data: {
        installationId: installation.id,
        connectorKey: "mail",
        name: "Mail",
        transport: "stdio",
        authType: "none",
        status: "ready",
      },
    });
    await prisma.pluginConnection.create({
      data: {
        installationId: installation.id,
        connectorKey: "plain",
        name: "Plain",
        transport: "stdio",
        authType: "none",
        status: "ready",
      },
    });
    await prisma.pluginConnection.create({
      data: {
        installationId: installation.id,
        connectorKey: "mail",
        alias: "off",
        name: "Off",
        transport: "stdio",
        authType: "none",
        status: "needs_auth",
      },
    });

    await poller.pollDue();
    expect(calls).toEqual([{ tool: "poll_new_mail", args: { cursor: null } }]);
    expect(dispatched).toEqual([
      {
        id: "mail-1",
        source: "email",
        kind: "received",
        text: "Subject: Hi",
        channel: "bot@example.com",
      },
    ]);
    expect(
      (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } }))
        .eventCursor
    ).toEqual({
      mailbox: "bot@example.com",
      uidValidity: "7",
      uidNext: 43,
    });

    now = new Date(now.getTime() + 30_000);
    await poller.pollDue();
    expect(calls).toHaveLength(1);

    now = new Date(now.getTime() + 30_000);
    reply = { isError: true, content: [{ type: "text", text: "IMAP login failed" }] };
    await poller.pollDue();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual({
      cursor: { mailbox: "bot@example.com", uidValidity: "7", uidNext: 43 },
    });
    expect(
      (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } }))
        .eventCursor
    ).toEqual({
      mailbox: "bot@example.com",
      uidValidity: "7",
      uidNext: 43,
    });

    // A dispatch failure keeps the cursor so the same delivery IDs are retried (and deduplicated).
    now = new Date(now.getTime() + 60_000);
    reply = text({
      events: [{ id: "mail-2", kind: "received", text: "x", channel: "bot@example.com" }],
      cursor: { uidNext: 44 },
    });
    const failing = new PluginEventPoller(
      prisma,
      async () => reply,
      async () => {
        throw new Error("database unavailable");
      },
      () => now
    );
    await failing.pollDue();
    expect(
      (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } }))
        .eventCursor
    ).toEqual({
      mailbox: "bot@example.com",
      uidValidity: "7",
      uidNext: 43,
    });

    // Reconfiguring the account (a new runtime generation) discards an in-flight cursor.
    now = new Date(now.getTime() + 60_000);
    const racing = new PluginEventPoller(
      prisma,
      async () => {
        await prisma.pluginConnection.update({
          where: { id: connection.id },
          data: { runtimeGeneration: { increment: 1 } },
        });
        return text({ events: [], cursor: { uidNext: 99 } });
      },
      async () => undefined,
      () => now
    );
    await racing.pollDue();
    expect(
      (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } }))
        .eventCursor
    ).toEqual({
      mailbox: "bot@example.com",
      uidValidity: "7",
      uidNext: 43,
    });
  } finally {
    await prisma.pluginInstallation.deleteMany({ where: { pluginKey } });
    await prisma.$disconnect();
  }
});

test("connector tools marked host-only are never listed for Bots", async () => {
  const { PluginTransport, HOST_ONLY_TOOL_META } = await import("../src/services/plugin/transport");
  const transport = new PluginTransport(
    {} as never,
    {} as never,
    "http://127.0.0.1:8787",
    async () =>
      Response.json({
        state: "ready",
        tools: [
          {
            name: "send_email",
            description: "Send",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: false },
          },
          {
            name: "poll_new_mail",
            description: "Host poll",
            inputSchema: { type: "object" },
            _meta: { [HOST_ONLY_TOOL_META]: true },
          },
        ],
      })
  );
  expect((await transport.stdioStatus("connection")).tools.map((tool) => tool.name)).toEqual([
    "send_email",
  ]);
});

test("connector results keep non-secret setup values and scrub secrets", async () => {
  if (!url) return;
  const prisma = createPrismaClient(url);
  const { PluginTransport } = await import("../src/services/plugin/transport");
  const pluginKey = `redact-${crypto.randomUUID().slice(0, 8)}`;
  let request: Record<string, any> = {};
  const transport = new PluginTransport(
    prisma,
    {} as never,
    "http://127.0.0.1:8787",
    async (_path, init) => {
      request = JSON.parse(String(init?.body));
      return Response.json({
        result: {
          content: [
            {
              type: "text",
              text: "From bot@example.test (auto-replied); password s3cret-app-password",
            },
          ],
        },
      });
    }
  );
  try {
    const installation = await prisma.pluginInstallation.create({
      data: {
        pluginKey,
        version: "1.0.0",
        name: "Redaction fixture",
        publisher: "Test",
        manifest: {
          key: pluginKey,
          name: "Redaction fixture",
          skills: [],
          connections: [{ key: "mail", transport: "stdio" }],
        },
      },
    });
    const connection = await prisma.pluginConnection.create({
      data: {
        installationId: installation.id,
        connectorKey: "mail",
        name: "Mail",
        transport: "stdio",
        authType: "none",
        status: "ready",
        configuration: {
          command: "bun",
          args: ["server.mjs"],
          env: {
            EMAIL_ADDRESS: "${EMAIL_ADDRESS}",
            EMAIL_PASSWORD: "${EMAIL_PASSWORD}",
            IMAP_SERVER: "${IMAP_SERVER}",
          },
          values: { EMAIL_ADDRESS: "bot@example.test", IMAP_SERVER: "auto" },
        },
        credentials: { values: { EMAIL_PASSWORD: "s3cret-app-password" } },
      },
    });
    const result = (await transport.callHostTool(connection, "poll_new_mail", {
      cursor: null,
    })) as { content: Array<{ text: string }> };
    expect(request.configuration.env).toMatchObject({
      EMAIL_ADDRESS: "bot@example.test",
      EMAIL_PASSWORD: "s3cret-app-password",
      IMAP_SERVER: "auto",
    });
    expect(result.content[0]!.text).toBe(
      "From bot@example.test (auto-replied); password [redacted]"
    );
  } finally {
    await prisma.pluginInstallation.deleteMany({ where: { pluginKey } });
    await prisma.$disconnect();
  }
});

test("server-side callers can invoke a connector's declared host tools; Bot calls cannot", async () => {
  if (!url) return;
  const prisma = createPrismaClient(url);
  const { PluginInvocations } = await import("../src/services/plugin/invocations");
  const { PluginTransport } = await import("../src/services/plugin/transport");
  const pluginKey = `host-${crypto.randomUUID().slice(0, 8)}`;
  const executed: string[] = [];
  // The real execution path, with the Bot computer replaced by a stub.
  const transport = new PluginTransport(
    prisma,
    {} as never,
    "http://127.0.0.1:8787",
    async (_path, init) => {
      executed.push(JSON.parse(String(init?.body)).toolName);
      return Response.json({ result: { content: [{ type: "text", text: "{}" }] } });
    }
  );
  const invocations = new PluginInvocations(prisma, (callId) =>
    transport.executeInvocation(callId)
  );
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  try {
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Host tool fixture",
        defaultDirectory: "/workspace",
        conversation: { create: { id: conversationId } },
      },
    });
    const message = await prisma.message.create({
      data: {
        botId,
        conversationId,
        role: "user",
        content: "x",
        clientId: `host-${runId}`,
        status: "completed",
      },
    });
    await prisma.run.create({
      data: { id: runId, botId, conversationId, userMessageId: message.id, status: "running" },
    });
    const installation = await prisma.pluginInstallation.create({
      data: {
        pluginKey,
        version: "1.0.0",
        name: "Host",
        publisher: "Test",
        manifest: {
          key: pluginKey,
          name: "Host",
          skills: [],
          connections: [
            {
              key: "mail",
              transport: "stdio",
              drafts: { platform: "email", tool: "send_reviewed_email" },
            },
            { key: "remote", transport: "http" },
          ],
        },
      },
    });
    const configuration = { command: "bun", args: ["server.mjs"] };
    const stdio = await prisma.pluginConnection.create({
      data: {
        installationId: installation.id,
        connectorKey: "mail",
        name: "Mail",
        transport: "stdio",
        authType: "none",
        status: "ready",
        toolSnapshot: [],
        configuration,
      },
    });
    const http = await prisma.pluginConnection.create({
      data: {
        installationId: installation.id,
        connectorKey: "remote",
        name: "Remote",
        transport: "http",
        authType: "none",
        status: "ready",
        toolSnapshot: [],
      },
    });
    const call = (connectionId: string, toolName: string, hostTool?: boolean) =>
      invocations.invoke({
        connectionId,
        botId,
        runId,
        callId: crypto.randomUUID(),
        toolName,
        arguments: { action: "send" },
        hostTool,
      });
    await expect(call(stdio.id, "send_reviewed_email")).rejects.toThrow("Plugin tool not found");
    expect(executed).toEqual([]);
    await call(stdio.id, "send_reviewed_email", true);
    expect(executed).toEqual(["send_reviewed_email"]);
    await expect(call(stdio.id, "some_hidden_tool", true)).rejects.toThrow(
      "declares no such host tool"
    );
    await expect(call(http.id, "send_reviewed_email", true)).rejects.toThrow(
      "declares no such host tool"
    );
    expect(executed).toHaveLength(1);
  } finally {
    await prisma.pluginInstallation.deleteMany({ where: { pluginKey } });
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
  }
});
