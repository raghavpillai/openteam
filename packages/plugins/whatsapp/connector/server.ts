import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ToolContent } from "../../_shared/google";
import { ResultStore } from "../../_shared/results";
import { WhatsAppAccount } from "./account";
import { installExecutable, prepareStore, settings, WacliProcess } from "./process";
import { whatsappTools } from "./tools";

export async function serveWhatsApp(account: WhatsAppAccount, transport: Transport = new StdioServerTransport()) {
  const results = new ResultStore("whatsapp", account.settings.accountId);
  const tools = [...whatsappTools(account), results.tool()];
  const entries = new Map(tools.map((entry) => [entry.name, { entry, validate: createToolValidator(entry.inputSchema) }]));
  const server = new Server({ name: "openteam-whatsapp", version: "1.0.12" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ run, ...definition }) => definition) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const match = entries.get(request.params.name);
      if (!match) throw new Error("Unknown WhatsApp tool");
      const args = request.params.arguments ?? {};
      const validation = match.validate(args);
      if (!validation.valid) throw new Error(`Invalid tool arguments: ${validation.errorMessage}`);
      const value = await match.entry.run(args);
      // Pairing challenges stay transient and never enter the paged-result cache.
      if (value instanceof ToolContent) return { content: value.content };
      return { content: [{ type: "text", text: JSON.stringify(request.params.name === "read_result" ? value : await results.capture(value)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "WhatsApp tool failed" }] };
    }
  });
  server.onclose = () => { void account.close(); };
  await server.connect(transport);
  return server;
}

export async function runServer() {
  process.umask(0o077);
  // Interpolated arguments carry scalar setup values as explicit strings,
  // including when this portable package is launched outside the host adapter.
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    "read-only": { type: "string" }, "max-messages": { type: "string" },
  } });
  const configuration = settings(process.env, undefined, { readOnly: values["read-only"], maxMessages: values["max-messages"] });
  await prepareStore(configuration);
  const executable = await installExecutable(fileURLToPath(new URL("..", import.meta.url)));
  const account = new WhatsAppAccount(new WacliProcess(executable, configuration), configuration);
  const stop = () => { void account.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await account.initialize();
  await serveWhatsApp(account);
}

if (import.meta.main) {
  try { await runServer(); }
  catch (error) { console.error(error instanceof Error ? error.message : "WhatsApp connector could not start"); process.exitCode = 1; }
}
