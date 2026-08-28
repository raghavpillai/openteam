// biome-ignore-all lint/suspicious/noThenProperty: The external Computer contract intentionally names its action sequence "then".
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CALL_DYNAMIC_TOOL_TOOL,
  COMPUTER_TOOL,
  COMPUTER_USE_TOOL,
  ComputerSteerRequest,
  ComputerTurnRequest,
  ComputerUseInput,
  CreateBotInput,
  CURSOR_TOOL_NAMES,
  CURSOR_TOOLS,
  EXTERNAL_READ_TOOL,
  EXTERNAL_SHELL_TOOL,
  GET_DYNAMIC_TOOLS_TOOL,
  NATIVE_TOOLS,
  REACT_TO_MESSAGE_TOOL,
  READ_TOOL,
  ReactToChannelMessageInput,
  RenameChannelInput,
  SCREENSHOT_TOOL,
  ScreenActionInput,
  SendMessageInput,
  SendToAgentInput,
  SHELL_TOOL,
  TaskInput,
  TodoWriteInput,
  UPDATE_STATE_TOOL,
  UpdateBotInput,
  UpdateStateInput,
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

  test("accepts hiding a bot from the sidebar", () => {
    expect(Schema.decodeUnknownSync(UpdateBotInput)({ hiddenFromSidebar: true })).toEqual({
      hiddenFromSidebar: true,
    });
  });

  test("rejects an empty message", () => {
    expect(() =>
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "",
        clientId: "message-1",
      })
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

  test("accepts replies to durable channel messages", () => {
    expect(
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "Following up",
        clientId: "message-reply-1",
        replyToMessageId: "7c68ab56-7cbe-4e52-9634-c73ae971f5cf",
      })
    ).toMatchObject({
      content: "Following up",
      replyToMessageId: "7c68ab56-7cbe-4e52-9634-c73ae971f5cf",
    });
  });

  test("accepts inline image uploads and rejects remote image URLs", () => {
    const image = { url: "data:image/png;base64,iVBORw0KGgo=" };
    expect(
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "What is in this image?",
        clientId: "message-image-1",
        images: [image],
      })
    ).toMatchObject({ images: [image] });
    expect(
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "",
        clientId: "message-image-only-1",
        images: [image],
      })
    ).toMatchObject({ content: "", images: [image] });
    expect(() =>
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "Fetch this",
        clientId: "message-image-2",
        images: [{ url: "https://example.com/image.png" }],
      })
    ).toThrow();
  });

  test("matches Grokbot's file, HTTPS, and data URL image schema for direct A2A", () => {
    expect(
      Schema.decodeUnknownSync(SendToAgentInput)({
        target_id: "f9853a2e-3c07-49a3-854c-fdee0588e68d",
        message: "Review this image.",
        images: [
          { url: "file:///workspace/reference.png" },
          { url: "https://example.com/image.png", alt: "Reference" },
          { url: "data:image/png;base64,AQID" },
        ],
      }).images
    ).toHaveLength(3);
  });

  test("validates user reactions to channel messages", () => {
    expect(
      Schema.decodeUnknownSync(ReactToChannelMessageInput)({
        emoji: "❤️",
        clientId: "reaction-message-1",
        timeZone: "Asia/Jerusalem",
      })
    ).toEqual({
      emoji: "❤️",
      clientId: "reaction-message-1",
      timeZone: "Asia/Jerusalem",
    });
    expect(() =>
      Schema.decodeUnknownSync(ReactToChannelMessageInput)({
        emoji: "",
        clientId: "reaction-message-2",
      })
    ).toThrow();
  });

  test("validates direct chat rename requests", () => {
    expect(
      Schema.decodeUnknownSync(RenameChannelInput)({
        name: "a2a",
        clientId: "rename-chat-1",
        timeZone: "Asia/Jerusalem",
      })
    ).toEqual({
      name: "a2a",
      clientId: "rename-chat-1",
      timeZone: "Asia/Jerusalem",
    });
    expect(() =>
      Schema.decodeUnknownSync(RenameChannelInput)({
        name: "",
        clientId: "rename-chat-2",
      })
    ).toThrow();
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
        contextSessionId: "context-1",
        screenBotId: "parent-bot-1",
        conversationId: "conversation-1",
        sessionPath: null,
        content: "Review the attached media",
        clientMessageId: "message-1",
        cwd: "/workspace/bots/reviewer",
        instructions: "Review carefully",
        todoUpdate: "- [in_progress] audit: Review parity",
        automationTrigger: "<automation_trigger_info>Scheduled audit</automation_trigger_info>",
        resetSelfSummaryCount: false,
        channelId: "channel-1",
        deliveryId: null,
        runtimeProfile: "subagent",
        subagentType: "browserUse",
        fileAttachments: ["/workspace/shared/clip.mp4"],
        images: [{ url: "data:image/webp;base64,UklGRg==" }],
        dynamicNamespaces: [
          {
            name: "utility_default",
            description: "Fixture tools",
            namespaceStatus: "ready",
            tools: [
              {
                connectionId: "connection-1",
                name: "echo",
                description: "Echo text",
                inputSchema: { type: "object" },
                source: "utility/fixture",
              },
            ],
          },
        ],
      })
    ).toMatchObject({
      runtimeProfile: "subagent",
      subagentType: "browserUse",
      screenBotId: "parent-bot-1",
      fileAttachments: ["/workspace/shared/clip.mp4"],
      images: [{ url: "data:image/webp;base64,UklGRg==" }],
      todoUpdate: "- [in_progress] audit: Review parity",
      automationTrigger: "<automation_trigger_info>Scheduled audit</automation_trigger_info>",
      resetSelfSummaryCount: false,
      dynamicNamespaces: [{ name: "utility_default" }],
    });
  });

  test("validates bounded graphical computer actions", () => {
    expect(
      Schema.decodeUnknownSync(ScreenActionInput)({
        action: "click",
        x: 640,
        y: 400,
      })
    ).toEqual({ action: "click", x: 640, y: 400 });
    expect(() =>
      Schema.decodeUnknownSync(ScreenActionInput)({
        action: "click",
        x: 1280,
        y: 400,
      })
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ScreenActionInput)({
        action: "key",
        keys: ["ctrl+l;rm"],
      })
    ).toThrow();
  });

  test("declares screenshot and structured computer tools", () => {
    expect(SCREENSHOT_TOOL.name).toBe("Screenshot");
    expect(COMPUTER_TOOL.name).toBe("Computer");
  });

  test("validates the specialized computer-use action sequence", () => {
    expect(
      Schema.decodeUnknownSync(ComputerUseInput)({
        action: "drag",
        path: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
        then: [
          { action: "key", key: "ctrl+l" },
          { action: "type", text: "https://example.com" },
          { action: "key", key: "Return" },
        ],
      }).then
    ).toHaveLength(3);
    expect(() =>
      Schema.decodeUnknownSync(ComputerUseInput)({
        action: "drag",
        x: 10,
        y: 20,
      })
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ComputerUseInput)({
        action: "click",
        then: [{ action: "screenshot" }],
      })
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ComputerUseInput)({
        action: "click",
        x: 10,
        y: 20,
        then: [],
      })
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ComputerUseInput)({
        action: "click",
        x: 10,
        y: 20,
        then: Array.from({ length: 10 }, () => ({ action: "wait" })),
      })
    ).toThrow();
    expect(COMPUTER_USE_TOOL.name).toBe("Computer");
    expect(COMPUTER_USE_TOOL.inputSchema.properties.then.maxItems).toBe(9);
  });

  test("declares the attachment's ten native tools", () => {
    expect(NATIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "SendToUser",
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

  test("declares only the approved ten-tool Cursor-compatible subset", () => {
    expect(CURSOR_TOOL_NAMES).toEqual([
      "CheckSubagent",
      "CreateAgent",
      "CreateChannel",
      "SendToAgent",
      "MessageSubagent",
      "StopSubagent",
      "Task",
      "TodoWrite",
      "UpdateAgent",
      "UpdateChannel",
    ]);
    expect(CURSOR_TOOLS).toEqual(cursorToolsDocument.cursor);
    const taskTool = CURSOR_TOOLS.find((tool) => tool.tool === "Task");
    expect(taskTool?.description).toContain("private wakes for you");
    expect(taskTool?.description).toContain("do not add a Task card");
    expect(taskTool?.description).not.toContain("already include a user-visible summary portion");
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
          {
            id: "investigate",
            content: "Find the cause",
            status: "in_progress",
          },
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
    ).toMatchObject({
      target: "routine",
      action: "create",
      schedule: "@daily",
    });
    expect(
      Schema.decodeUnknownSync(UpdateStateInput)({
        target: "settings",
        action: "set",
        dreaming_enabled: true,
      })
    ).toMatchObject({ dreaming_enabled: true });
  });
});
