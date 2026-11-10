import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import QRCode from "qrcode";
import { configuredService, type SignalService } from "./service";

const string = (description: string, maximum = 256) => ({
  type: "string",
  description,
  minLength: 1,
  maxLength: maximum,
});

export function signalTools(service: SignalService) {
  const tool = (
    name: string,
    description: string,
    properties: Record<string, any>,
    required: string[],
    run: (args: any) => unknown,
    readOnly = true
  ) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly },
    ...(["signal_status", "start_link", "finish_link", "cancel_link", "remove_account"].includes(
      name
    )
      ? { _meta: { "openteam/hostOnly": true } }
      : {}),
    run,
  });
  return [
    tool("signal_status", "Check the linked account and signal-cli runtime version.", {}, [], () =>
      service.status()
    ),
    tool(
      "start_link",
      "Start linking an existing mobile Signal account. Encode deviceLinkUri as a QR code and scan it in Signal's Linked Devices settings. The URI is sensitive and expires quickly.",
      {},
      [],
      async () => {
        const link = await service.startLink();
        return {
          sessionId: link.sessionId,
          expiresAt: link.expiresAt,
          qrCodeDataUrl: await QRCode.toDataURL(link.deviceLinkUri, { width: 320, margin: 4 }),
        };
      },
      false
    ),
    tool(
      "finish_link",
      "Wait for the mobile device to approve the active linking session and begin collecting new messages.",
      { sessionId: string("Session ID from start_link") },
      ["sessionId"],
      (a) => service.beginFinishLink(a.sessionId),
      false
    ),
    tool(
      "cancel_link",
      "Cancel the active device approval.",
      { sessionId: string("Active session ID") },
      ["sessionId"],
      (a) => service.cancelLink(a.sessionId),
      false
    ),
    tool(
      "remove_account",
      "Stop this linked device before deleting its local account state.",
      {},
      [],
      () => service.removeAccount(),
      false
    ),
    tool("list_contacts", "List known contacts for this linked Signal account.", {}, [], () =>
      service.accountRequest("listContacts")
    ),
    tool("list_groups", "List known groups for this linked Signal account.", {}, [], () =>
      service.accountRequest("listGroups")
    ),
    tool(
      "list_messages",
      "Read locally collected ordinary messages, newest arrival first. Search is a literal, case-sensitive substring. History starts when the collector connects. Disappearing and view-once content is excluded.",
      {
        chat: string("Exact contact:ACI or group:ID from a previous result"),
        query: string("Literal text to find", 1000),
        before: {
          type: "integer",
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          description: "nextCursor from the previous page",
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      [],
      (a) => service.store.list(a)
    ),
    tool(
      "send_message",
      "Send a text message from this Signal account. Supply a unique requestId and exactly one destination. Reusing an identical requestId inspects its saved outcome and prevents duplicate sends. An unknown outcome requires inspection before attempting another send.",
      {
        requestId: string("Stable caller-generated ID for this one send", 128),
        recipient: string("Phone number, ACI, or u:username"),
        groupId: string("Signal group ID"),
        noteToSelf: { type: "boolean" },
        message: string("Text to send", 16_000),
      },
      ["requestId", "message"],
      (a) =>
        service.send(
          a.requestId,
          {
            ...(a.recipient ? { recipient: a.recipient } : {}),
            ...(a.groupId ? { groupId: a.groupId } : {}),
            ...(a.noteToSelf ? { noteToSelf: true } : {}),
          },
          a.message
        ),
      false
    ),
    tool(
      "read_attachment",
      "Read an already downloaded attachment referenced by a collected ordinary message in this account. Encoded results must fit the connector's 75000-character response limit.",
      {
        messageId: string("Collected message ID"),
        attachmentId: string("Attachment ID from that message"),
      },
      ["messageId", "attachmentId"],
      (a) => service.attachment(a.messageId, a.attachmentId)
    ),
  ];
}

export async function serve(service: SignalService) {
  const server = new Server(
    { name: "openteam-signal", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  const tools = signalTools(service).map((entry) => ({
    ...entry,
    validate: createToolValidator(entry.inputSchema),
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ run, validate, ...definition }) => definition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const tool = tools.find((t) => t.name === request.params.name);
      if (!tool) throw new Error("Unknown tool.");
      const args = request.params.arguments ?? {};
      const validation = tool.validate(args);
      if (!validation.valid) throw new Error("Invalid tool arguments. Check the tool schema.");
      const result = await tool.run(args);
      const text = JSON.stringify(result);
      // Leave margin below OpenTeam's 100000-character string and 200000-character result caps.
      if (text.length > 75_000)
        throw new Error(
          "Result exceeds this connector's 75000-character encoded response limit. Reduce the message page size or use a smaller attachment."
        );
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : "Signal tool failed." },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport());
  return server;
}

if (import.meta.main) {
  process.umask(0o077);
  const service = configuredService();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
  };
  process.once("SIGTERM", () => {
    void close().then(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void close().then(() => process.exit(0));
  });
  process.stdin.once("end", () => {
    void close();
  });
  // Discovery and setup remain available while an account is unlinked or the runtime is unavailable.
  await serve(service);
  void service.connect().catch(() => {});
}
