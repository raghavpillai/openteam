import { expect, test } from "bun:test";
import { Effect } from "effect";
import { connectorDraftCardReminder } from "../src/services/connector-draft-reminder";
import { InternalToolService } from "../src/services/internal-tool-service";

const manifest = (drafts?: Record<string, string>) => ({
  key: "gmail", name: "Gmail", skills: [],
  connections: [{ key: "gmail", name: "Gmail", ...(drafts ? { drafts } : {}) }],
});
const call = async (options: { origin?: string; child?: boolean; toolName?: string; result?: unknown; drafts?: Record<string, string> | null }) => {
  const prisma = {
    run: { findUnique: async ({ where }: { where: { id: string } }) => where.id === "parent-run" ? { origin: "user" }
      : { id: "current", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, status: "running", origin: options.origin ?? "user", inboxEvents: [] } },
    subagent: { findUnique: async () => options.child ? { id: "child", parentBotId: "parent", parentRunId: "parent-run", subagentType: "executor" } : null },
    automationResult: { findUnique: async () => null },
    pluginConnection: { findUnique: async () => ({ connectorKey: "gmail", installation: { name: "Gmail", manifest: manifest(options.drafts === null ? undefined : options.drafts ?? { platform: "email", tool: "send_reviewed_email" }) } }) },
  };
  const result = options.result ?? { content: [{ type: "text", text: JSON.stringify({ id: "r-1", messageId: "m-1" }) }] };
  const plugins = { invoke: async () => result };
  const service = new InternalToolService(prisma as never, {} as never, {} as never, async () => {}, {} as never, {} as never, {} as never, plugins as never);
  return (await Effect.runPromise(service.execute({ runId: "current", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, callId: crypto.randomUUID(),
    tool: "PluginCall", arguments: { connectionId: "connection", toolName: options.toolName ?? "create_draft", arguments: {} } }))) as { content: Array<{ text: string }> };
};

test("a Gmail create_draft reminds the main agent that the user expects the draft card", async () => {
  const result = await call({});
  expect(result.content.map((item) => item.text)).toEqual([
    JSON.stringify({ id: "r-1", messageId: "m-1" }),
    "\n\n<system_reminder>\nThis saved a draft in the user's Gmail mailbox. If it is for a file you are about to attach with UploadFile, or the user asked you to save the draft in their mailbox, carry on. Otherwise the user expects the in-app draft card: show the same message with DraftExternalMessage, and tell the user a Gmail draft was also saved. Leave that draft as it is.\n</system_reminder>",
  ]);
  expect(result.content[1]!.text).toBe(connectorDraftCardReminder("Gmail"));
});

test("no reminder where no card can be drafted, after a failure, or for other tools and connectors", async () => {
  for (const options of [
    { origin: "routine" },
    { child: true },
    { toolName: "get_draft" },
    { drafts: null },
    { result: { isError: true, content: [{ type: "text", text: "Not called: the attachment a.pdf is incomplete" }] } },
  ]) expect((await call(options)).content).toHaveLength(1);
});
