// biome-ignore-all lint/suspicious/noThenProperty: The external Computer contract intentionally names its action sequence "then".

import { describe, expect, test } from "bun:test";
import { referenceTool } from "../src/tool-contracts";
import { Schema } from "effect";
import {
  AdminBroadcastInput,
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
  ListAgentsInput,
  ListGroupsInput,
  NATIVE_TOOL_NAMES,
  NATIVE_TOOLS,
  PLUGIN_BOT_ACCESS_PAGE_SIZE,
  PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH,
  PLUGIN_CONNECTION_ID_MAX_LENGTH,
  PLUGIN_CONNECTION_STATUS_MAX_IDS,
  REACT_TO_MESSAGE_TOOL,
  READ_TOOL,
  ReactToChannelMessageInput,
  RenameChannelInput,
  SCREENSHOT_TOOL,
  ScreenActionInput,
  SendMessageInput,
  SendToAgentInput,
  SetChannelAvatarInput,
  SHELL_TOOL,
  TaskInput,
  TodoWriteInput,
  UPDATE_STATE_TOOL,
  UpdateBotInput,
  UpdateChannelProfileInput,
  UpdateStateInput,
  UploadAssetInput,
} from "../src";
import cursorToolsDocument from "../src/cursor-tools.json";
import nativeToolsDocument from "../src/native-tools.json";



describe("API contracts", () => {
  test("validates bounded internal administrator broadcasts", () => {
    const botIds = ["7dbba9ea-1a2b-4af9-aa32-a2d3aaeb10a9", "9df96b0a-1739-4335-9341-22132a6c4f7b"];
    expect(
      Schema.decodeUnknownSync(AdminBroadcastInput)({
        clientId: "broadcast-release-0001",
        message: "The local runtime will restart tonight.",
        botIds,
      })
    ).toEqual({
      clientId: "broadcast-release-0001",
      message: "The local runtime will restart tonight.",
      botIds,
    });
    expect(() =>
      Schema.decodeUnknownSync(AdminBroadcastInput)({
        clientId: "broadcast-release-0002",
        message: "The local runtime will restart tonight.",
        botIds: ["not-a-uuid"],
      })
    ).toThrow();
  });

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

  test("accepts canonical attachment references and rejects inline message bytes", () => {
    const attachment = {
      assetId: "a".repeat(64),
      fileName: "upload.png",
      mimeType: "image/png",
      byteSize: 12,
      kind: "image" as const,
    };
    expect(
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "What is in this image?",
        clientId: "message-image-1",
        attachments: [attachment],
      })
    ).toMatchObject({ attachments: [attachment] });
    expect(
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "",
        clientId: "message-image-only-1",
        attachments: [attachment],
      })
    ).toMatchObject({ content: "", attachments: [attachment] });
    expect(() =>
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "",
        clientId: "message-image-2",
        images: [{ url: "data:image/png;base64,AQID" }],
      })
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(UploadAssetInput)({
        fileName: "upload.png",
        mimeType: "image/png",
        bytesBase64: "AQID",
      })
    ).toMatchObject({ fileName: "upload.png", bytesBase64: "AQID" });
  });

  test("matches OpenTeam's file, HTTPS, and data URL image schema for direct A2A", () => {
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

  test("validates setting and clearing a group avatar", () => {
    expect(
      Schema.decodeUnknownSync(SetChannelAvatarInput)({
        pngBase64: "iVBORw0KGgo=",
        clientId: "group-avatar-set-1",
      })
    ).toEqual({ pngBase64: "iVBORw0KGgo=", clientId: "group-avatar-set-1" });
    expect(
      Schema.decodeUnknownSync(SetChannelAvatarInput)({
        pngBase64: null,
        clientId: "group-avatar-clear-1",
      })
    ).toEqual({ pngBase64: null, clientId: "group-avatar-clear-1" });
  });

  test("validates persisted group name and description updates", () => {
    expect(
      Schema.decodeUnknownSync(UpdateChannelProfileInput)({
        name: "Parity room",
        description: "Coordinate exact A2A checks.",
        clientId: "group-profile-1",
      })
    ).toEqual({
      name: "Parity room",
      description: "Coordinate exact A2A checks.",
      clientId: "group-profile-1",
    });
    expect(() =>
      Schema.decodeUnknownSync(UpdateChannelProfileInput)({
        name: "Parity room",
        description: "x".repeat(2_001),
        clientId: "group-profile-2",
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
        requestSource: "event",
        channelId: "channel-1",
        deliveryId: null,
        runtimeProfile: "subagent",
        subagentType: "browserUse",
        model: "openai-codex/gpt-5.5",
        reasoning: "high",
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
      model: "openai-codex/gpt-5.5",
      reasoning: "high",
      screenBotId: "parent-bot-1",
      fileAttachments: ["/workspace/shared/clip.mp4"],
      images: [{ url: "data:image/webp;base64,UklGRg==" }],
      todoUpdate: "- [in_progress] audit: Review parity",
      automationTrigger: "<automation_trigger_info>Scheduled audit</automation_trigger_info>",
      resetSelfSummaryCount: false,
      requestSource: "event",
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
    expect(
      Schema.decodeUnknownSync(ScreenActionInput)({
        action: "drag",
        path: [
          { x: 20, y: 40 },
          { x: 300, y: 420 },
        ],
      })
    ).toEqual({
      action: "drag",
      path: [
        { x: 20, y: 40 },
        { x: 300, y: 420 },
      ],
    });
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

  test("declares the current native tools, including machine discovery", () => {
    expect(NATIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "SendToUser",
      "ReactToMessage",
      "RecallMemory",
      "ListSections",
      "update_state",
      "ExternalShell",
      "ExternalRead",
      "ListMachines",
      "Shell",
      "Read",
      "Screenshot",
      "GetDynamicTools",
      "CallDynamicTool",
    ]);
    expect(NATIVE_TOOLS).toHaveLength(13);
    for (const tool of NATIVE_TOOLS.filter(tool => !["ExternalShell","ExternalRead"].includes(tool.name))) {
      const expected = referenceTool(tool.name);
      expect({name:tool.name,description:tool.description,inputSchema:tool.inputSchema}).toEqual(expected);
    }
    expect(NATIVE_TOOLS.some((tool) => tool.name === "AddMcpServer")).toBe(false);
    expect(REACT_TO_MESSAGE_TOOL.name).toBe("ReactToMessage");
    expect(EXTERNAL_SHELL_TOOL.name).toBe("ExternalShell");
    expect(EXTERNAL_READ_TOOL.name).toBe("ExternalRead");
    expect(SHELL_TOOL.name).toBe("Shell");
    expect(READ_TOOL.name).toBe("Read");
    expect(GET_DYNAMIC_TOOLS_TOOL.name).toBe("GetDynamicTools");
    expect(CALL_DYNAMIC_TOOL_TOOL.name).toBe("CallDynamicTool");
    expect(NATIVE_TOOL_NAMES).not.toContain("SendMessage");
  });

  test("pins delivery contracts including named secrets and saved-login requests", () => {
    const sendToUser = NATIVE_TOOLS.find((tool) => tool.name === "SendToUser");
    const reactToMessage = NATIVE_TOOLS.find((tool) => tool.name === "ReactToMessage");
    const sendToAgent = CURSOR_TOOLS.find((tool) => tool.tool === "SendToAgent");

    expect(sendToUser?.description).toContain('credential-request');
    expect(sendToUser?.description).not.toContain('cursor-agent');
    const schema = sendToUser!.inputSchema as any;
    expect(schema.properties.type.enum).toEqual(['text','attachment','widget','secret-request','credential-request']);
    expect(schema.properties.secret.properties).toHaveProperty('name');
    expect(schema.properties.secret.properties).toHaveProperty('connector');
    expect(schema.properties.credential).toHaveProperty('properties');
    expect(reactToMessage!.inputSchema).toEqual(referenceTool('ReactToMessage').inputSchema);
    expect(sendToAgent!.inputSchema).toEqual(referenceTool('SendToAgent').inputSchema);
  });

  test("declares the supported Cursor-compatible subset including AwaitShell", () => {
    expect(CURSOR_TOOL_NAMES).toEqual([
      "AwaitShell",
      "CheckSubagent",
      "CreateAgent",
      "CreateChannel",
      "ListAgents",
      "ListGroups",
      "SendToAgent",
      "MessageSubagent",
      "StopSubagent",
      "Task",
      "request_box_help",
      "TodoWrite",
      "UpdateAgent",
      "UpdateChannel",
      "CopyToBox", "CopyFromBox", "WebSearch", "WebFetch", "request_user_form", "remap_user_form_targets", "DraftExternalMessage", "SendFeedback", "create_bot_share_json",
      "WakeParent",
    ]);
    for (const tool of CURSOR_TOOLS.filter(tool => !['ListAgents','ListGroups'].includes(tool.tool))) {
      expect(tool.description).toEqual(referenceTool(tool.tool).description);
      expect(tool.inputSchema).toEqual(referenceTool(tool.tool).inputSchema);
    }
    const taskTool = CURSOR_TOOLS.find((tool) => tool.tool === "Task");
    const taskSchema = taskTool?.inputSchema as {
      properties: Record<string, { description?: string }>;
      required: string[];
    };
    expect(Object.keys(taskSchema.properties)).toEqual([
      "description",
      "prompt",
      "resume",
      "subagent_type",
      "file_attachments",
      "run_in_background",
      "model",
    ]);
    expect(taskSchema.required).toEqual(["description", "prompt"]);
    expect(taskSchema.properties.description?.description).toBe(
      "A short, user-friendly title for the subagent. This appears in the UI as the subagent's name. Make it concrete and distinct, consider recent titles to avoid reuse. For resumed subagents which you are prompting to work on a separate task, give an updated description based on the latest work the subagent is performing. (Do not rename if the subagent is continuing work on the same high-level task.)"
    );
    expect(taskSchema.properties.prompt?.description).toBe("The task for the agent to perform");
    expect((taskSchema.properties.subagent_type as any).enum).toContain('browserUse');
    expect((taskSchema.properties.model as any).type).toBe('string');
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
    expect(() =>
      Schema.decodeUnknownSync(TodoWriteInput)({
        todos: Array.from({ length: 65 }, (_, index) => ({
          id: `todo-${index}`,
          content: "bounded",
          status: "pending" as const,
        })),
        merge: false,
      })
    ).not.toThrow();
    for (const todo of [
      { id: "x".repeat(121), content: "bounded", status: "pending" as const },
      { id: "bounded", content: "x".repeat(1_001), status: "pending" as const },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(TodoWriteInput)({
          todos: [todo, { id: "second", content: "bounded", status: "pending" }],
          merge: false,
        })
      ).not.toThrow();
    }
  });

  test("validates bounded read-only agent and group directory inputs", () => {
    expect(Schema.decodeUnknownSync(ListAgentsInput)({ query: "research", limit: 50 })).toEqual({
      query: "research",
      limit: 50,
    });
    expect(Schema.decodeUnknownSync(ListGroupsInput)({})).toEqual({});
    for (const schema of [ListAgentsInput, ListGroupsInput]) {
      expect(() => Schema.decodeUnknownSync(schema)({ limit: 51 })).toThrow();
      expect(() => Schema.decodeUnknownSync(schema)({ limit: 0 })).toThrow();
      expect(() => Schema.decodeUnknownSync(schema)({ query: "x".repeat(121) })).toThrow();
    }
  });

  test("keeps plugin Bot-access pages and search terms bounded", () => {
    expect(PLUGIN_BOT_ACCESS_PAGE_SIZE).toBe(60);
    expect(PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH).toBe(120);
    expect(PLUGIN_CONNECTION_STATUS_MAX_IDS).toBe(50);
    expect(PLUGIN_CONNECTION_ID_MAX_LENGTH).toBe(120);
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
  });
});
