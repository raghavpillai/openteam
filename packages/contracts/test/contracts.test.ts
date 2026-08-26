import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CALL_DYNAMIC_TOOL_TOOL,
  COMPUTER_TOOL,
  ComputerTurnRequest,
  ComputerSteerRequest,
  CURSOR_TOOLS,
  CURSOR_TOOL_NAMES,
  CreateBotInput,
  EXTERNAL_READ_TOOL,
  EXTERNAL_SHELL_TOOL,
  GET_DYNAMIC_TOOLS_TOOL,
  NATIVE_TOOLS,
  REACT_TO_MESSAGE_TOOL,
  READ_TOOL,
  SCREENSHOT_TOOL,
  ScreenActionInput,
  SendMessageInput,
  SHELL_TOOL,
  UPDATE_STATE_TOOL,
  UpdateStateInput,
  TaskInput,
  TodoWriteInput,
} from "../src";
import cursorToolsDocument from "../src/cursor-tools.json";
import nativeToolsDocument from "../src/native-tools.json";

describe("API contracts", () => {
  test("accepts a valid bot", () => {
    const value = Schema.decodeUnknownSync(CreateBotInput)({
      clientRequestId: "create-researcher-0001",
      name: "Researcher",
      instructions: "Keep notes in the shared workspace.",
      color: "#4f7cff",
    });
    expect(value.name).toBe("Researcher");
  });

  test("accepts a zero-configuration bot creation request", () => {
    const value = Schema.decodeUnknownSync(CreateBotInput)({
      clientRequestId: "create-default-0001",
    });
    expect(value).toEqual({ clientRequestId: "create-default-0001" });
  });

  test("rejects an empty message", () => {
    expect(() =>
      Schema.decodeUnknownSync(SendMessageInput)({ content: "", clientId: "message-1" })
    ).toThrow();
  });

  test("accepts the viewer time zone with a message", () => {
    expect(
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "What time did I send this?",
        clientId: "message-time-zone-1",
        timeZone: "America/New_York",
      })
    ).toEqual({
      content: "What time did I send this?",
      clientId: "message-time-zone-1",
      timeZone: "America/New_York",
    });
  });

  test("validates a live steering delivery", () => {
    expect(
      Schema.decodeUnknownSync(ComputerSteerRequest)({
        inboxId: "inbox-1",
        clientMessageId: "message-1",
        content: "Redirect the current work",
      })
    ).toEqual({
      inboxId: "inbox-1",
      clientMessageId: "message-1",
      content: "Redirect the current work",
    });
  });

  test("carries subagent runtime profiles and media attachments to the computer", () => {
    expect(
      Schema.decodeUnknownSync(ComputerTurnRequest)({
        runId: "run-1",
        botId: "bot-1",
        conversationId: "conversation-1",
        sessionPath: null,
        content: "Review the attached media",
        clientMessageId: "message-1",
        cwd: "/workspace/bots/reviewer",
        instructions: "Review carefully",
        channelId: "channel-1",
        deliveryId: null,
        runtimeProfile: "subagent",
        fileAttachments: ["/workspace/shared/clip.mp4"],
      })
    ).toMatchObject({
      runtimeProfile: "subagent",
      fileAttachments: ["/workspace/shared/clip.mp4"],
    });
  });

  test("validates bounded graphical computer actions", () => {
    expect(
      Schema.decodeUnknownSync(ScreenActionInput)({ action: "click", x: 640, y: 400 })
    ).toEqual({ action: "click", x: 640, y: 400 });
    expect(() =>
      Schema.decodeUnknownSync(ScreenActionInput)({ action: "click", x: 1280, y: 400 })
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ScreenActionInput)({ action: "key", keys: ["ctrl+l;rm"] })
    ).toThrow();
  });

  test("declares screenshot and structured computer tools", () => {
    expect(SCREENSHOT_TOOL.name).toBe("Screenshot");
    expect(COMPUTER_TOOL.name).toBe("Computer");
  });

  test("declares the attachment's ten native tools", () => {
    expect(NATIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "SendMessage",
      "ReactToMessage",
      "update_state",
      "ExternalShell",
      "ExternalRead",
      "Shell",
      "Read",
      "Screenshot",
      "GetDynamicTools",
      "CallDynamicTool",
    ]);
    expect(NATIVE_TOOLS).toHaveLength(10);
    expect(
      NATIVE_TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        parameters: inputSchema,
      }))
    ).toEqual(nativeToolsDocument.native);
    expect(NATIVE_TOOLS.some((tool) => tool.name === "AddMcpServer")).toBe(false);
    expect(REACT_TO_MESSAGE_TOOL.name).toBe("ReactToMessage");
    expect(EXTERNAL_SHELL_TOOL.name).toBe("ExternalShell");
    expect(EXTERNAL_READ_TOOL.name).toBe("ExternalRead");
    expect(SHELL_TOOL.name).toBe("Shell");
    expect(READ_TOOL.name).toBe("Read");
    expect(GET_DYNAMIC_TOOLS_TOOL.name).toBe("GetDynamicTools");
    expect(CALL_DYNAMIC_TOOL_TOOL.name).toBe("CallDynamicTool");
  });

  test("declares only the approved nine-tool Cursor-compatible subset", () => {
    expect(CURSOR_TOOL_NAMES).toEqual([
      "CheckSubagent",
      "CreateAgent",
      "CreateChannel",
      "MessageSubagent",
      "StopSubagent",
      "Task",
      "TodoWrite",
      "UpdateAgent",
      "UpdateChannel",
    ]);
    expect(CURSOR_TOOLS).toEqual(cursorToolsDocument.cursor);
    expect(CURSOR_TOOL_NAMES).not.toContain("AddMcpServer");
    expect(
      Schema.decodeUnknownSync(TaskInput)({
        description: "Inspect failing tests",
        prompt: "Find the cause and return the relevant files and evidence.",
        subagent_type: "executor",
        run_in_background: true,
      })
    ).toMatchObject({ subagent_type: "executor", run_in_background: true });
    expect(
      Schema.decodeUnknownSync(TodoWriteInput)({
        todos: [
          { id: "investigate", content: "Find the cause", status: "in_progress" },
          { id: "verify", content: "Run verification", status: "pending" },
        ],
        merge: false,
      }).todos
    ).toHaveLength(2);
    expect(() =>
      Schema.decodeUnknownSync(TodoWriteInput)({
        todos: [{ id: "only", content: "Only one", status: "pending" }],
        merge: false,
      })
    ).toThrow();
  });

  test("declares durable update_state with routine compatibility", () => {
    expect(UPDATE_STATE_TOOL.name).toBe("update_state");
    const inputSchema = UPDATE_STATE_TOOL.inputSchema as {
      properties: { target: { enum: readonly string[] } };
    };
    expect(inputSchema.properties.target.enum).toContain("routine");
    expect(
      Schema.decodeUnknownSync(UpdateStateInput)({
        target: "memory",
        action: "write",
        fact: "The user prefers concise status updates.",
        tier: "profile",
        scope: "user",
      })
    ).toEqual({
      target: "memory",
      action: "write",
      fact: "The user prefers concise status updates.",
      tier: "profile",
      scope: "user",
    });
    expect(
      Schema.decodeUnknownSync(UpdateStateInput)({
        target: "routine",
        action: "create",
        name: "Daily brief",
        prompt: "Send a concise morning brief.",
        schedule: "@daily",
      })
    ).toMatchObject({ target: "routine", action: "create", schedule: "@daily" });
  });
});
