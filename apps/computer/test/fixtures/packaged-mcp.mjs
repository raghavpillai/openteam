import { createInterface } from "node:readline";
let extra = false;
const tool = (name) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
});
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (!("id" in request)) continue;
  let result;
  if (request.method === "initialize")
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "packaged-qa", version: "1.0.0" },
    };
  else if (request.method === "tools/list")
    result =
      request.params?.cursor === "second"
        ? { tools: [tool("context"), ...(extra ? [tool("added")] : [])] }
        : { tools: [tool("echo")], nextCursor: "second" };
  else if (request.method === "tools/call") {
    if (request.params.name === "echo") {
      extra = true;
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n"
      );
      result = { content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }] };
    } else
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              argument: process.argv[2],
              cwd: process.cwd(),
              label: process.env.PLUGIN_LABEL,
              inheritedSecret: Boolean(
                process.env.OPENTEAM_CONTROL_TOKEN || process.env.DATABASE_URL
              ),
            }),
          },
        ],
      };
  } else if (request.method === "ping") result = {};
  else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Unknown method" },
      }) + "\n"
    );
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
