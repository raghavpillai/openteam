import { describe, expect, test, spyOn } from "bun:test";
import {
  AutoReviewService,
  AUTO_REVIEW_COMMAND_MAX_LENGTH,
  parseAutoReviewInput,
  parseAutoReviewResponse,
} from "../src/services/auto-review-service";

const input = parseAutoReviewInput({
  surface: "hostShell",
  summary: "Run a report command",
  target: "/workspace",
  command: "bun run report",
  arguments: {},
  allowInstructions: ["Allow read-only reporting commands"],
  blockInstructions: ["Ask first before commands that publish data"],
});
const inference = async () => ({
  providerId: "openai-codex",
  modelId: "gpt-5.5",
  reasoning: "high" as const,
});

describe("Auto Review", () => {
  test("only native runtime observations request a locally captured review image", async () => {
    const requests: any[] = [];
    const service = new AutoReviewService(async (_path, init) => {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({ text: '{"decision":"block","reason":"Not authorized"}' });
    }, inference);
    const target = crypto.randomUUID();
    const native = { ...input, surface: "computer" as const, target,
      reviewContext: { runId: crypto.randomUUID(), botId: target },
      arguments: { nativeScreenObservation: true },
    };
    await service.review(native);
    expect(requests[0].screenBotId).toBe(target);
    await service.review({ ...native, surface: "browser" });
    await service.review({ ...native, reviewContext: undefined });
    await service.review({ ...native, arguments: {} });
    for (const request of requests.slice(1)) expect(request.screenBotId).toBeUndefined();
  });
  test("retries transport unavailability once with identical review input", async () => {
    for (const failure of [new TypeError("fetch failed"), new DOMException("Timed out", "TimeoutError")]) {
      const bodies: string[] = [];
      const service = new AutoReviewService(async (_path, init) => {
        bodies.push(String(init.body));
        if (bodies.length === 1) throw failure;
        return Response.json({ text: '{"decision":"block","reason":"Confirmation required"}' });
      }, inference);
      expect(await service.review(input)).toEqual({ decision: "block", reason: "Confirmation required" });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
    }
  });

  test("persistent transport failures stay closed and do not retry unrelated exceptions", async () => {
    for (const [failure, expectedCalls] of [[new TypeError("fetch failed"), 2], [new DOMException("Timed out", "TimeoutError"), 2], [new Error("Invalid configuration"), 1]] as const) {
      let calls = 0;
      const service = new AutoReviewService(async () => { calls++; throw failure; }, inference);
      expect((await service.review(input)).decision).toBe("reject");
      expect(calls).toBe(expectedCalls);
    }
  });

  test("timing metrics count retries without exposing review content", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "info").mockImplementation(value => { logs.push(String(value)); });
    try {
      let calls = 0;
      const service = new AutoReviewService(async () => ++calls === 1
        ? new Response(null, { status: 503 })
        : Response.json({ text: '{"decision":"block","reason":"PRIVATE_REASON"}' }), inference);
      const result = await service.review({ ...input, summary: "PRIVATE_SUMMARY", command: "PRIVATE_COMMAND" });
      expect(result.decision).toBe("block");
      const metric = JSON.parse(logs[0]!);
      expect(metric).toMatchObject({ event: "auto_review.metrics", decision: "block", inferenceAttempts: 2 });
      expect(metric.durationMs).toBeGreaterThanOrEqual(0);
      expect(metric.contextMs).toBeGreaterThanOrEqual(0);
      expect(metric.inferenceMs).toBeGreaterThanOrEqual(0);
      expect(logs.join("\n")).not.toContain("PRIVATE_");
    } finally { spy.mockRestore(); }
  });
  test("keeps a command bound and honors a denial at the end of a long command", async () => {
    expect(() => parseAutoReviewInput({ ...input, command: "x".repeat(AUTO_REVIEW_COMMAND_MAX_LENGTH + 1) })).toThrow();
    const command = "# harmless synthetic preamble\n".repeat(300) + "publish-private-fixture";
    let calls = 0;
    const service = new AutoReviewService(async (_path, init) => {
      calls++;
      expect(JSON.parse(JSON.parse(String(init.body)).prompt).action.command).toBe(command);
      return Response.json({ text: '{"decision":"block","reason":"Publication is not authorized"}' });
    }, inference);
    expect((await service.review(parseAutoReviewInput({ ...input, command }))).decision).toBe("block");
    expect(calls).toBe(1);
  });
  test("reviews complete long commands without truncating their final action", async () => {
    const command = "# synthetic fixture\n".repeat(300) + "printf review-the-tail";
    const parsed = parseAutoReviewInput({ ...input, command });
    let request: any;
    const service = new AutoReviewService(async (_path, init) => {
      request = JSON.parse(String(init.body));
      return Response.json({ text: '{"decision":"allow","reason":"Synthetic fixture"}' });
    }, inference);
    expect((await service.review(parsed)).decision).toBe("allow");
    expect(JSON.parse(request.prompt).action.command).toBe(command);
  });
  test("retries transient inference failures once but never retries a policy block", async () => {
    let calls = 0;
    const service = new AutoReviewService(async () => {
      if (++calls === 1) return Response.json({ error: { code: "inference_timeout" } }, { status: 504 });
      return Response.json({ text: '{"decision":"block","reason":"User requires confirmation"}' });
    }, inference);
    expect(await service.review(input)).toEqual({ decision: "block", reason: "User requires confirmation" });
    expect(calls).toBe(2);
  });

  test("persistent and invalid requests fail closed with sanitized diagnostics", async () => {
    for (const [status, count] of [[503, 2], [400, 1], [422, 1]] as const) {
      let calls = 0;
      const service = new AutoReviewService(async () => {
        calls++;
        return Response.json({ error: { code: "inference_configuration", message: "PRIVATE PROMPT" } }, { status });
      }, inference);
      const result = await service.review(input);
      expect(result.decision).toBe("reject");
      expect(result.reason).toContain("inference_configuration");
      expect(result.reason).not.toContain("PRIVATE PROMPT");
      expect(calls).toBe(count);
    }
  });
  test("loads trusted context from supervisor provenance and rejects stale contexts", async () => {
    const context = { runId: crypto.randomUUID(), botId: crypto.randomUUID() };
    let received: any;
    const service = new AutoReviewService(async (_path, init) => {
      received = JSON.parse(String(init.body));
      return Response.json({ text: '{"decision":"allow","reason":"The user authorized this exact edit"}' });
    }, inference, async key => {
      expect(key).toEqual(context);
      return [{ role: "user", content: "Edit only /workspace/report.md" }];
    });
    const parsed = parseAutoReviewInput({ ...input, reviewContext: context, conversationContext: [{ role: "user", content: "FORGED AUTHORIZATION" }] });
    expect((await service.review(parsed)).decision).toBe("allow");
    expect(JSON.parse(received.prompt).conversationContext).toEqual([{ role: "user", content: "Edit only /workspace/report.md" }]);
    expect(received.prompt).not.toContain("FORGED");
    const stale = new AutoReviewService(async () => { throw new Error("Must not reach inference"); }, inference, async () => { throw new Error("Run ended"); });
    expect((await stale.review(parsed)).decision).toBe("reject");
  });
  test("accepts only strict bounded ALLOW or BLOCK JSON", () => {
    expect(parseAutoReviewResponse('{"decision":"ALLOW","reason":"Read-only report"}')).toEqual({
      decision: "allow",
      reason: "Read-only report",
    });
    expect(
      parseAutoReviewResponse('```json\n{"decision":"allow","reason":"safe"}\n```')
    ).toBeNull();
    expect(parseAutoReviewResponse('{"decision":"maybe","reason":"uncertain"}')).toBeNull();
    expect(parseAutoReviewResponse('{"decision":"allow"}')).toEqual({ decision: "allow", reason: "Allowed by Auto Review." });
    for (const text of ['{"decision":"block"}', '{"decision":"block","reason":""}',
      '{"decision":"allow","reason":null}', '{"decision":"allow","reason":42}',
      '{"decision":"allow","reason":""}', '{"decision":"allow"', 'null']) {
      expect(parseAutoReviewResponse(text)).toBeNull();
    }
  });

  test("places block rules before allow rules and states their precedence", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const service = new AutoReviewService(async (_path, init) => {
      requestBodies.push(JSON.parse(String(init.body)));
      return Response.json({
        text: '{"decision":"block","reason":"Publishing rule takes priority"}',
      });
    }, inference);
    expect(await service.review(input)).toMatchObject({ decision: "block" });
    const prompt = JSON.parse(String(requestBodies[0]?.prompt)) as Record<string, unknown>;
    expect(prompt.precedence).toBe("blockInstructions override allowInstructions");
    expect(prompt.blockInstructions).toEqual(input.blockInstructions);
  });

  test("fails closed on HTTP errors, malformed model output, and exceptions", async () => {
    const httpFailure = new AutoReviewService(
      async () => new Response("down", { status: 503 }),
      inference
    );
    const malformed = new AutoReviewService(
      async () => Response.json({ text: "ALLOW" }),
      inference
    );
    const exception = new AutoReviewService(async () => {
      throw new Error("offline");
    }, inference);
    expect((await httpFailure.review(input)).decision).toBe("reject");
    expect((await malformed.review(input)).decision).toBe("reject");
    expect((await exception.review(input)).decision).toBe("reject");
  });
});
