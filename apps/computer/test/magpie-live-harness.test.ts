import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";

for (const behavior of [
  "discovery failure",
  "no screenshot",
  "wrong answer",
  "truncated after correct answer",
  "stalled after correct answer",
] as const) {
  test(`live Magpie harness rejects ${behavior}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "magpie-harness-negative-"));
    await writeFile(join(root, "result.json"), JSON.stringify({ success: true }));
    let imageRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (behavior === "discovery failure") return new Response("Unavailable", { status: 503 });
        if (new URL(request.url).pathname === "/v1/models")
          return Response.json({
            data: [{ id: "fixture/vision", modalities: { input: ["text", "image"] } }],
          });
        const body = (await request.json()) as any;
        const image = body.messages
          .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
          .find((part: any) => part.type === "image_url");
        const screenshot = behavior !== "no screenshot" && !image;
        let answer = "LEFT=purple; RIGHT=purple";
        if (image) {
          imageRequests++;
          const canvas = await createJimp({ formats: [png] }).read(
            Buffer.from(image.image_url.url.split(",")[1], "base64")
          );
          const names: Record<string, string> = {
            ff0000ff: "red",
            "0000ffff": "blue",
            "00aa00ff": "green",
            ffff00ff: "yellow",
          };
          if (
            behavior === "stalled after correct answer" ||
            behavior === "truncated after correct answer"
          )
            answer = `LEFT=${names[canvas.getPixelColor(300, 400).toString(16).padStart(8, "0")]}; RIGHT=${names[canvas.getPixelColor(960, 400).toString(16).padStart(8, "0")]}`;
        }
        const delta = screenshot
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "capture",
                  type: "function",
                  function: { name: "Computer", arguments: '{"action":"screenshot"}' },
                },
              ],
            }
          : { role: "assistant", content: answer };
        const chunk = {
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        };
        const first = `data: ${JSON.stringify(chunk)}\n\n`;
        if (image && behavior === "stalled after correct answer") {
          // The colors are correct, but the response never completes. A deadline
          // abort must fail the harness rather than turning partial text into PASS.
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(first));
              },
            }),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
        const end = {
          ...chunk,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: screenshot
                ? "tool_calls"
                : behavior === "truncated after correct answer"
                  ? "length"
                  : "stop",
            },
          ],
        };
        return new Response(first + `data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const script =
      process.env.PR198_TEST_HARNESS_SCRIPT ??
      resolve(import.meta.dir, "../scripts/test-magpie-capabilities.ts");
    const child = Bun.spawn([process.execPath, script], {
      env: {
        PATH: process.env.PATH!,
        PI_OFFLINE: "1",
        MAGPIE_BASE_URL: server.url.origin + "/v1",
        MAGPIE_MODEL: "fixture/vision",
        MAGPIE_TEST_OUTPUT: root,
        MAGPIE_TEST_TIMEOUT_MS: behavior === "stalled after correct answer" ? "1500" : "5000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(stdout).not.toContain("PASS:");
      if (behavior === "discovery failure") expect(stderr).toContain("discovery returned 503");
      if (behavior === "no screenshot")
        expect(stderr).toContain("must request and receive a screenshot");
      if (behavior === "wrong answer") expect(stderr).toContain("AssertionError");
      if (behavior === "truncated after correct answer")
        expect(stderr).toContain("must complete normally");
      if (behavior === "stalled after correct answer") {
        expect(imageRequests).toBeGreaterThan(0);
        expect(stderr).toContain("deadline");
      }
      const result = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
      expect(result.success).toBe(false);
    } finally {
      child.kill();
      await child.exited;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}
