import { expect, test } from "bun:test";
import { NativeToolExecutor, HostApprovalRequiredError } from "../src/native-tool-executor";
import { parseAutoReviewInput } from "../../server/src/services/auto-review-service";

test("long Task prompts fit review labels without truncating the actions being reviewed", async () => {
  let reviewed: any;
  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      reviewed = await request.json();
      parseAutoReviewInput({ ...reviewed, allowInstructions: [], blockInstructions: [] });
      return Response.json({ allowed: true });
    },
  });
  try {
    const executor = new NativeToolExecutor({
      agentDir: "/tmp",
      controlToken: "synthetic",
      serverUrl: api.url.origin,
    });
    const prompt =
      "Read the synthetic test page. ".repeat(80) + " Verify every result before finishing.";
    await executor.autoReviewTask({
      prompt,
      description: "Full browser workflow",
      subagent_type: "computerUse",
    });
    expect(reviewed.summary.length).toBeLessThanOrEqual(500);
    expect(reviewed.arguments.prompt).toBe(prompt);
    expect(reviewed.arguments.task).toContain(prompt);
  } finally {
    api.stop(true);
  }
});

for (const response of [
  {
    status: 400,
    body: { error: { code: "invalid_auto_review", message: "Action is malformed or too large" } },
    error: "Action is malformed or too large",
  },
  {
    status: 503,
    body: { error: "Review service unavailable" },
    error: "Review service unavailable",
  },
  { status: 200, body: { allowed: false }, error: "did not authorize" },
  {
    status: 409,
    body: {
      approval: {
        gate: "auto-review",
        requestMethod: "openteam/autoReview",
        details: { reason: "Fixture denial" },
      },
    },
    error: HostApprovalRequiredError,
  },
])
  test(`review failure remains a failure (${response.status}) with the actual reason`, async () => {
    const api = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json(response.body, { status: response.status }),
    });
    try {
      const executor = new NativeToolExecutor({
        agentDir: "/tmp",
        controlToken: "synthetic",
        serverUrl: api.url.origin,
      });
      await expect(
        executor.autoReviewTask({ prompt: "Read fixture", description: "Read" })
      ).rejects.toThrow(response.error);
    } finally {
      api.stop(true);
    }
  });
