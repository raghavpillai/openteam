import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { CodexAppServerClient } from "../src";

let client: CodexAppServerClient | undefined;

afterEach(async () => {
  await client?.stop();
});

describe("Codex app-server JSONL client", () => {
  test("initializes, starts a durable thread, and receives turn notifications", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [resolve(import.meta.dir, "fake-app-server.mjs")],
    });
    const initialized = await client.start();
    expect(initialized.userAgent).toContain("fake-codex");

    const thread = await client.startThread({
      cwd: "/workspace/bots/test",
      instructions: "Be useful.",
    });
    expect(thread.thread.id).toBe("thread-1");

    const methods: string[] = [];
    const unsubscribe = client.onNotification((event) => methods.push(event.method));
    const turn = await client.startTurn({
      threadId: thread.thread.id,
      content: "Hello",
      clientMessageId: "message-1",
      cwd: "/workspace/bots/test",
    });
    expect(turn.turn.id).toBe("turn-1");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    unsubscribe();
    expect(methods).toContain("turn/completed");
  });

  test("reports a child crash and can initialize a replacement process", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [resolve(import.meta.dir, "fake-app-server.mjs")],
      env: { FAKE_EXIT_AFTER_INITIALIZE: "1" },
    });
    const exited = new Promise<void>((resolveExit) => {
      client!.onExit((error) => {
        expect(error.message).toContain("exited (42");
        resolveExit();
      });
    });
    await client.start();
    await exited;
    expect(client.ready).toBe(false);

    const restarted = await client.start();
    expect(restarted.userAgent).toContain("fake-codex");
  });

  test("declares OpenBot tools and resolves a Codex dynamic tool callback", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [resolve(import.meta.dir, "fake-app-server.mjs")],
      env: { FAKE_DYNAMIC_TOOL: "1", FAKE_REQUIRE_DYNAMIC: "1" },
    });
    await client.start();
    const thread = await client.startThread({
      cwd: "/workspace/bots/tools",
      instructions: "Talk.",
    });

    const received = new Promise<void>((resolveTool) => {
      client!.onDynamicTool((request) => {
        expect(request.method).toBe("item/tool/call");
        expect(request.params.tool).toBe("SendMessage");
        expect(request.params.arguments).toEqual({
          type: "text",
          content: "Visible from dynamic tool",
        });
        client!.resolveDynamicTool(request.rpcId, {
          contentItems: [{ type: "inputText", text: "Message sent" }],
          success: true,
        });
        resolveTool();
      });
    });
    const completed = new Promise<void>((resolveTurn) => {
      client!.onNotification((notification) => {
        if (notification.method === "turn/completed") resolveTurn();
      });
    });
    await client.startTurn({
      threadId: thread.thread.id,
      content: "Use your visible voice",
      clientMessageId: "message-tools-1",
      cwd: "/workspace/bots/tools",
    });
    await received;
    await completed;
  });

  test("uses Docker as the execution sandbox for durable bot threads", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [resolve(import.meta.dir, "fake-app-server.mjs")],
      env: { FAKE_REQUIRE_CONTAINER_SANDBOX: "1" },
    });
    await client.start();
    const thread = await client.startThread({
      cwd: "/workspace/bots/container-sandbox",
      instructions: "Use the isolated OpenBot computer.",
    });
    expect(thread.thread.id).toBe("thread-1");
    const resumed = await client.resumeThread({
      threadId: thread.thread.id,
      cwd: "/workspace/bots/container-sandbox",
      instructions: "Keep using the isolated OpenBot computer.",
    });
    expect(resumed.thread.id).toBe("thread-1");
  });
});
