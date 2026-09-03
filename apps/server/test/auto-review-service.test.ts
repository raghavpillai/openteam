import { describe, expect, test } from "bun:test";
import {
  AutoReviewService,
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
  test("accepts only strict bounded ALLOW or BLOCK JSON", () => {
    expect(parseAutoReviewResponse('{"decision":"ALLOW","reason":"Read-only report"}')).toEqual({
      decision: "allow",
      reason: "Read-only report",
    });
    expect(
      parseAutoReviewResponse('```json\n{"decision":"allow","reason":"safe"}\n```')
    ).toBeNull();
    expect(parseAutoReviewResponse('{"decision":"maybe","reason":"uncertain"}')).toBeNull();
    expect(parseAutoReviewResponse('{"decision":"allow"}')).toBeNull();
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
