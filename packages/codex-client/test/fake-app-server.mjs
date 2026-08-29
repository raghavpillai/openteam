import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let dynamicTurn = null;

const completeTurn = (threadId) => {
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId,
      turnId: "turn-1",
      itemId: "item-1",
      delta: "Hello",
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId: "turn-1",
      item: { type: "agentMessage", id: "item-1", text: "Hello from Codex" },
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: "turn-1", status: "completed", items: [], error: null },
    },
  });
};

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex/0.144.5",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    if (process.env.FAKE_EXIT_AFTER_INITIALIZE === "1") {
      setTimeout(() => process.exit(42), 10);
    }
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    if (
      process.env.FAKE_REQUIRE_CONTAINER_SANDBOX === "1" &&
      message.params.sandbox !== "danger-full-access"
    ) {
      send({ id: message.id, error: { code: -32602, message: "container sandbox mode missing" } });
      return;
    }
    if (
      process.env.FAKE_REQUIRE_DYNAMIC === "1" &&
      (!Array.isArray(message.params.dynamicTools) ||
        !message.params.dynamicTools.some((tool) => tool.name === "SendToUser") ||
        !message.params.dynamicTools.some((tool) => tool.name === "SendToAgent") ||
        !message.params.dynamicTools.some((tool) => tool.name === "Screenshot") ||
        !message.params.dynamicTools.some((tool) => tool.name === "Computer"))
    ) {
      send({ id: message.id, error: { code: -32602, message: "dynamicTools missing" } });
      return;
    }
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId ?? "thread-1",
          sessionId: "session-1",
          cwd: message.params.cwd,
          cliVersion: "0.144.5",
        },
        model: "fake-model",
        modelProvider: "openai",
        cwd: message.params.cwd,
        instructionSources: [],
      },
    });
  } else if (message.method === "turn/start") {
    send({
      id: message.id,
      result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } },
    });
    send({
      method: "turn/started",
      params: {
        threadId: message.params.threadId,
        turn: { id: "turn-1", status: "inProgress", items: [], error: null },
      },
    });
    if (process.env.FAKE_DYNAMIC_TOOL === "1") {
      dynamicTurn = { threadId: message.params.threadId };
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId: "turn-1",
          item: {
            type: "dynamicToolCall",
            id: "dynamic-1",
            tool: "SendToUser",
            arguments: { type: "text", content: "Visible from dynamic tool" },
            status: "inProgress",
          },
        },
      });
      send({
        id: "tool-rpc-1",
        method: "item/tool/call",
        params: {
          threadId: message.params.threadId,
          turnId: "turn-1",
          callId: "dynamic-1",
          namespace: null,
          tool: "SendToUser",
          arguments: { type: "text", content: "Visible from dynamic tool" },
        },
      });
    } else {
      completeTurn(message.params.threadId);
    }
  } else if (message.method === "turn/interrupt" || message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
  } else if (message.id === "tool-rpc-1" && dynamicTurn) {
    if (!message.result?.success) process.exit(43);
    send({
      method: "item/completed",
      params: {
        threadId: dynamicTurn.threadId,
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "dynamic-1",
          tool: "SendToUser",
          arguments: { type: "text", content: "Visible from dynamic tool" },
          result: message.result.contentItems,
          success: true,
          status: "completed",
        },
      },
    });
    completeTurn(dynamicTurn.threadId);
    dynamicTurn = null;
  }
});
