// Deterministic local provider. The chaos runner changes only this container's mode file.
import { readFile, appendFile } from "node:fs/promises";
Bun.serve({
  port: 8799,
  async fetch(request) {
    const mode = await readFile("/tmp/mode", "utf8").catch(() => "ready");
    if (mode === "unauthorized")
      return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
    if (mode === "quota")
      return Response.json({ error: { message: "quota exceeded" } }, { status: 429 });
    if (mode === "unavailable")
      return Response.json({ error: { message: "model unavailable" } }, { status: 503 });
    const body = (await request.json()) as any;
    await appendFile("/tmp/requests", "request\n");
    const delivery =
      Array.isArray(body.tools) && JSON.stringify(body.tools).includes('"SendToUser"');
    const followsTool = body.messages?.at(-1)?.role === "tool";
    const delta =
      delivery && !followsTool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "chaos-delivery",
                type: "function",
                function: {
                  name: "SendToUser",
                  arguments: JSON.stringify({ type: "text", content: "OPENTEAM_CHAOS_OK" }),
                },
              },
            ],
          }
        : { role: "assistant", content: "OPENTEAM_CHAOS_OK" };
    const chunk = {
      id: "chaos-canary",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "chaos-model",
      choices: [
        { index: 0, delta, finish_reason: delivery && !followsTool ? "tool_calls" : "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  },
});
