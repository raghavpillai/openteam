/** Runs only inside test-e2e's disposable database. Real worker + Pi, local deterministic inference. */
import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerRuntime } from "../../apps/computer/src/runtime";
import { computerEventStream } from "../../apps/computer/src/computer-event-stream";
import { WakeWorker } from "../../apps/worker/src/worker";

const directory = process.argv[2]!;
assert(directory.includes("openteam-transcription-e2e-"), "Disposable fixture directory required");
const expected = JSON.parse(
  await readFile(join(directory, "delivery-expectations.json"), "utf8")
) as Array<{
  botId: string;
  clientId: string;
  text: string;
}>;
const requests: any[] = [];
let inferenceRunId = "";
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json();
    requests.push({ runId: inferenceRunId, body });
    const chunk = {
      id: "voice-qa",
      object: "chat.completion.chunk",
      created: 1,
      model: "voice-qa",
      choices: [
        { index: 0, delta: { role: "assistant", content: "Received." }, finish_reason: null },
      ],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } }
    );
  },
});
process.env.OPENTEAM_PI_AGENT_DIR = join(directory, "qa-pi");
await mkdir(process.env.OPENTEAM_PI_AGENT_DIR, { recursive: true });
await writeFile(
  join(process.env.OPENTEAM_PI_AGENT_DIR, "models.json"),
  JSON.stringify({
    providers: {
      "voice-qa": {
        baseUrl: model.url.origin + "/v1",
        api: "openai-completions",
        apiKey: "disposable-local-model",
        models: [
          {
            id: "voice-qa",
            name: "Voice QA",
            reasoning: false,
            input: ["text"],
            contextWindow: 200_000,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  })
);
await writeFile(
  join(process.env.OPENTEAM_PI_AGENT_DIR, "auth.json"),
  JSON.stringify({ "voice-qa": { type: "api_key", key: "disposable-local-model" } })
);
const runtime = new ComputerRuntime();
const turns: any[] = [];
const computer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/turns") {
      const input = await request.json();
      inferenceRunId = input.runId;
      turns.push(input);
      return new Response(computerEventStream(await runtime.run(input)), {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    if (path.startsWith("/v1/context-sessions/"))
      return Response.json(await runtime.contextState(path.split("/").at(-1)!));
    return new Response(null, { status: 404 });
  },
});
process.env.OPENTEAM_COMPUTER_URL = computer.url.origin;
const worker = new WakeWorker();
try {
  await worker.boss.start();
  for (const queue of ["bot-wake", "transcript-project", "bot-provision"])
    await worker.boss.createQueue(queue);
  await worker.agentData.writeInferenceSettings({
    providerId: "voice-qa",
    modelId: "voice-qa",
    reasoning: "off",
  });
  for (const botId of new Set(expected.map((entry) => entry.botId))) {
    await worker.prisma.bot.update({
      where: { id: botId },
      data: { status: "active", onboardingStatus: "completed" },
    });
    // Skip provisioning/bootstrap; exercise the real claim, prompt assembly, HTTP transport and Pi session.
    for (let attempt = 0; attempt < 20; attempt++) {
      const claimed = await (worker as any).claim(botId);
      if (!claimed) break;
      await (worker as any).execute(claimed);
    }
  }
  for (const item of expected) {
    const visible = await worker.prisma.channelMessage.findMany({
      where: { clientId: item.clientId },
    });
    assert.equal(visible.length, 1, "Exactly one stored user message per send");
    assert.equal(
      visible[0]!.content,
      item.text,
      "The stored message must equal the submitted transcript"
    );
    const matchingTurns = turns.filter((turn) => turn.clientMessageId === item.clientId);
    assert.equal(matchingTurns.length, 1, `Exactly one agent turn for ${item.clientId}`);
    assert(
      matchingTurns[0].content.includes(item.text),
      "Worker changed or dropped the transcript"
    );
    assert(
      requests.some(
        ({ runId, body }) =>
          runId === matchingTurns[0].runId &&
          body.messages?.some(
            (message: any) =>
              message.role === "user" &&
              (typeof message.content === "string"
                ? message.content.includes(item.text)
                : message.content?.some(
                    (part: any) => part.type === "text" && part.text.includes(item.text)
                  ))
          )
      ),
      "Actual Pi inference request did not include the exact submitted text"
    );
    console.log(
      `PASS agent delivery ${item.clientId}: exact stored text, one turn, exact text in Pi inference input`
    );
  }
  await writeFile(
    join(directory, "agent-delivery-results.json"),
    JSON.stringify(
      { checked: expected.length, turns: turns.length, inferenceRequests: requests.length },
      null,
      2
    )
  );
} finally {
  await worker.boss.stop();
  await worker.prisma.$disconnect();
  await computer.stop(true);
  await model.stop(true);
}
