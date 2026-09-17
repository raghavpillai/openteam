import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeTools } from "../../src/runtime/tools";

test("box shell waits for a chat decision, blocks concurrent side effects, and executes the approved command once", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-review-"));
  const reviews: any[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as any;
      if (new URL(request.url).pathname.endsWith("/tools/call"))
        return Response.json({ environment: {} });
      reviews.push(input);
      return input.autoReviewApproval
        ? Response.json({ allowed: true })
        : Response.json(
            {
              error: "approval_required",
              approval: {
                gate: "auto-review",
                requestMethod: "openteam/autoReview",
                details: {
                  type: "autoReview",
                  reason: "Fixture review",
                  supportsAlwaysAllow: false,
                },
              },
            },
            { status: 409 }
          );
    },
  });
  const tools = new RuntimeTools({} as any, api.url.origin, "fixture-control", root, root);
  let requested!: (event: any) => void;
  const approval = new Promise<any>((resolve) => {
    requested = resolve;
  });
  const botId = crypto.randomUUID(),
    runId = crypto.randomUUID();
  const active: any = {
    botId,
    runId,
    screenBotId: botId,
    cwd: root,
    queue: { push: requested },
    requestSource: "user",
    runtimeProfile: "main",
  };
  const target = join(root, "approved.txt"),
    unintended = join(root, "unintended.txt");
  try {
    const work = (tools as any).executeOpenTeamTool(active, "review-shell", "Shell", {
      command: `printf approved > '${target}'`,
      block_until_ms: 1000,
    });
    const event = await approval;
    expect(await Bun.file(target).exists()).toBe(false);
    await expect(
      (tools as any).executeOpenTeamTool(active, "other-shell", "Shell", {
        command: `touch '${unintended}'`,
      })
    ).rejects.toThrow("waiting for approval");
    tools.resolveApproval(event.approvalId, "accept");
    await work;
    expect(await readFile(target, "utf8")).toBe("approved");
    expect(await Bun.file(unintended).exists()).toBe(false);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ surface: "boxShell", reviewContext: { runId, botId } });
    expect(reviews[1].command).toBe(reviews[0].command);
  } finally {
    api.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
