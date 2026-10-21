// biome-ignore-all lint/suspicious/noThenProperty: The external Computer contract intentionally names its action sequence "then".

import { describe, expect, test } from "bun:test";
import { referenceTool, SEND_TO_USER_BATCH_GUIDANCE } from "../src/tool-contracts";
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
  GET_DYNAMIC_TOOLS_TOOL,
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
  DISCONNECT_CHANNEL_TOOL,
  isStateTool,
  STATE_TOOL_TARGETS,
  UPDATE_AVATAR_TOOL,
  UPDATE_MEMORY_TOOL,
  UPDATE_PROFILE_TOOL,
  UPDATE_ROUTINE_TOOL,
  UPDATE_SKILL_TOOL,
  UpdateBotInput,
  UpdateChannelProfileInput,
  UpdateMemoryToolInput,
  UpdateProfileToolInput,
  UpdateRoutineToolInput,
  UploadAssetInput,
} from "../src";
import { describeTrigger, normalizeMainToolArguments } from "../src/reference-main-parsers";
import { renderControlResult } from "../src/tool-results";
import { ROBOT_AVATAR_SHAPES } from "../src/robot-avatar";
import { parseUserForm, userFormPreparationRefusal } from "../src/user-forms";
import cursorToolsDocument from "../src/cursor-tools.json";
import nativeToolsDocument from "../src/native-tools.json";
import toolReference from "../src/tool-reference.json";
import { APP_SETTINGS_ANCHORS } from "../src/app-deep-links";



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
        todoUpdate: "- **IN_PROGRESS**: Review parity (id: audit)",
        resetSelfSummaryCount: false,
        requestSource: "event",
        channelId: "channel-1",
        deliveryId: null,
        runtimeProfile: "subagent",
        subagentType: "computerUse",
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
      subagentType: "computerUse",
      model: "openai-codex/gpt-5.5",
      reasoning: "high",
      screenBotId: "parent-bot-1",
      fileAttachments: ["/workspace/shared/clip.mp4"],
      images: [{ url: "data:image/webp;base64,UklGRg==" }],
      todoUpdate: "- **IN_PROGRESS**: Review parity (id: audit)",
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
      "UpdateMemory",
      "UpdateRoutine",
      "ListMachines",
      "Shell",
      "Read",
      "Screenshot",
      "GetDynamicTools",
      "CallDynamicTool",
    ]);
    expect(NATIVE_TOOLS).toHaveLength(12);
    for (const tool of NATIVE_TOOLS) {
      const expected = referenceTool(tool.name);
      expect({name:tool.name,description:tool.description,inputSchema:tool.inputSchema}).toEqual(expected);
    }
    expect(NATIVE_TOOLS.some((tool) => tool.name === "AddMcpServer")).toBe(false);
    expect(REACT_TO_MESSAGE_TOOL.name).toBe("ReactToMessage");
    expect(SHELL_TOOL.name).toBe("Shell");
    expect(READ_TOOL.name).toBe("Read");
    expect(GET_DYNAMIC_TOOLS_TOOL.name).toBe("GetDynamicTools");
    expect(CALL_DYNAMIC_TOOL_TOOL.name).toBe("CallDynamicTool");
    expect(NATIVE_TOOL_NAMES).not.toContain("SendMessage");
  });

  test("pins delivery contracts including named secrets", () => {
    const sendToUser = NATIVE_TOOLS.find((tool) => tool.name === "SendToUser");
    const reactToMessage = NATIVE_TOOLS.find((tool) => tool.name === "ReactToMessage");
    const sendToAgent = CURSOR_TOOLS.find((tool) => tool.tool === "SendToAgent");

    expect(sendToUser?.description).not.toContain('credential-request');
    expect(sendToUser?.description).not.toContain('ListCredentials');
    expect(sendToUser?.description).not.toContain('cursor-agent');
    const schema = sendToUser!.inputSchema as any;
    expect(schema.properties.type.enum).toEqual(['text','attachment','widget','secret-request']);
    expect(schema.properties.secret.properties).toHaveProperty('name');
    expect(schema.properties.secret.properties).toHaveProperty('connector');
    expect(schema.properties).not.toHaveProperty('credential');
    expect(reactToMessage!.inputSchema).toEqual(referenceTool('ReactToMessage').inputSchema);
    expect(sendToAgent!.inputSchema).toEqual(referenceTool('SendToAgent').inputSchema);
  });

  test("SendToUser is the reference's concise main-agent render with only OpenTeam's adaptations", () => {
    // The capture is the concise variant the reference's main agent gets: end_turn on, and no
    // credential requests, in-app actions, link items, cards, threaded replies or task threads.
    const captured = toolReference.SendToUser;
    // Every captured tool takes OpenTeam's product name and link scheme.
    const [, scheme] = /\]\((\w+):\/\/app\/v1\/settings\?id=update-channel\)/.exec(captured.description)!;
    const [, product] = /only in (.+) chat, never through a connector\./.exec(captured.description)!;
    const expected = JSON.parse(
      JSON.stringify(captured).replaceAll(product!, "OpenTeam").replaceAll(`${scheme}://`, "openteam://")
    );
    const properties = expected.inputSchema.properties;
    const texts: Record<string, { description: string }> = {
      tool: expected,
      type: properties.type,
      channel: properties.channel,
      "secret.name": properties.secret.properties.name,
    };
    const adaptations: Array<[keyof typeof texts, string | RegExp, string]> = [
      // Sign-ins, SSO and 2FA included, follow the Authentication section.
      ["tool", "(SSO, a passkey, 2FA, a captcha", "(a passkey, a captcha"],
      // Secrets are named variables or connector credential fields with a scope, never plugin fields.
      [
        "tool",
        "or with plugin_id a plugin's secret setup field (one request per key, after the plugin is installed).",
        'or with connector and field instead of name, that connector\'s credential file. A named secret takes scope "bot" (the default) or "personal".',
      ],
      ["secret.name", "; with plugin_id, the plugin's `${VAR}` setup field key exactly as GetPlugin lists it.", "."],
      // The app links only its own settings rows; there are no recovery, Bot template, agent or tab links.
      [
        "tool",
        "[Update Track](openteam://app/v1/settings?id=update-channel)",
        "[Web search provider](openteam://app/v1/settings?id=web-search-provider)",
      ],
      [
        "tool",
        /one of: [^.]+\. When stuck, link update-computer before reset-computer\./,
        `one of: ${APP_SETTINGS_ANCHORS.join(", ")}.`,
      ],
      ["tool", " Bot template: [label](openteam://app/v1/bot-template?id=<share id>).", ""],
      [
        "tool",
        " Another bot: [label](openteam://app/v1/agent?id=<id>). Your tab: [label](openteam://app/v1/sidebar?tab=<overview|routines|media|computer|members>).",
        "",
      ],
      // No cloud agents, and no Slack thread syntax in channel addresses.
      ["type", "cursor-agent: a cloud agent card; ", ""],
      ["channel", / Slack: .*$/, ""],
    ];
    for (const [key, from, to] of adaptations) {
      const text = texts[key]!;
      if (typeof from === "string") expect(text.description).toContain(from);
      else expect(text.description).toMatch(from);
      text.description = text.description.replace(from, () => to);
    }
    properties.type.enum = properties.type.enum.filter((type: string) => type !== "cursor-agent");
    delete properties.bcId;
    delete properties.voice_memo;
    const secret = properties.secret;
    delete secret.properties.plugin_id;
    const local = nativeToolsDocument.native.find((tool) => tool.name === "SendToUser")!.parameters.properties.secret!;
    for (const key of ["connector", "field", "scope"] as const) secret.properties[key] = local.properties[key];
    secret.required = ["label"];
    secret.oneOf = [
      { required: ["name"], not: { anyOf: [{ required: ["connector"] }, { required: ["field"] }] } },
      { required: ["connector", "field"], not: { required: ["name"] } },
    ];

    // OpenTeam's own batching paragraph follows the reference text.
    expected.description += ` ${SEND_TO_USER_BATCH_GUIDANCE}`;

    const actual = referenceTool("SendToUser");
    expect(actual.description).toBe(expected.description);
    expect(actual.inputSchema).toEqual(expected.inputSchema);
  });

  test("declares the supported Cursor-compatible subset including AwaitShell", () => {
    expect(CURSOR_TOOL_NAMES).toEqual([
      "AwaitShell",
      "CheckSubagent",
      "CreateAgent",
      "CreateChannel",
      "SendToAgent",
      "MessageSubagent",
      "StopSubagent",
      "Task",
      "request_box_help",
      "TodoWrite",
      "UpdateAgent",
      "UpdateChannel",
      "UpdateSkill", "UpdateProfile", "UpdateAvatar", "DisconnectChannel",
      "CopyToBox", "CopyFromBox", "WebSearch", "WebFetch", "RequestUserForm", "RemapUserFormTargets", "DraftExternalMessage", "SendFeedback", "CreateBotShareJson",
      "WakeParent",
    ]);
    for (const tool of CURSOR_TOOLS) {
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
    ]);
    expect(taskSchema.required).toEqual(["description", "prompt", "subagent_type"]);
    expect(taskSchema.properties.description?.description).toBe(
      "A short, user-friendly title for the subagent. This appears in the UI as the subagent's name. Make it concrete and distinct, consider recent titles to avoid reuse. For resumed subagents which you are prompting to work on a separate task, give an updated description based on the latest work the subagent is performing. (Do not rename if the subagent is continuing work on the same high-level task.)"
    );
    expect(taskSchema.properties.prompt?.description).toBe("The task for the agent to perform");
    expect((taskSchema.properties.subagent_type as any).enum).toContain('computerUse');
    expect((taskSchema.properties.subagent_type as any).enum).not.toContain('browserUse');
    expect(taskSchema.properties.model).toBeUndefined();
    expect(CURSOR_TOOL_NAMES).not.toContain("AddMcpServer");
    expect(
      Schema.decodeUnknownSync(TaskInput)({
        description: "Inspect failing tests",
        prompt: "Find the cause and return the relevant files and evidence.",
        subagent_type: "executor",
        run_in_background: true,
      })
    ).toMatchObject({ subagent_type: "executor", run_in_background: true });
    expect(() =>
      Schema.decodeUnknownSync(TaskInput)({
        description: "Open the page",
        prompt: "Open https://example.com and report its heading.",
        subagent_type: "browserUse",
      })
    ).toThrow();
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
    expect(Schema.decodeUnknownSync(TodoWriteInput)({
      todos: [{ id: "investigate", content: "Find the cause", status: "completed" }],
      merge: true,
    }).todos).toHaveLength(1);
    expect(Schema.decodeUnknownSync(TodoWriteInput)({
      todos: [{ id: "investigate", status: "completed" }], merge: true,
    }).todos[0]).toEqual({ id: "investigate", status: "completed" });
    expect(() => Schema.decodeUnknownSync(TodoWriteInput)({
      todos: [{ id: "a", status: "pending" }, { id: "b", content: "Complete", status: "pending" }], merge: false,
    })).toThrow("Replacement tasks require content and status");
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

  test("keeps plugin Bot-access pages and search terms bounded", () => {
    expect(PLUGIN_BOT_ACCESS_PAGE_SIZE).toBe(60);
    expect(PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH).toBe(120);
    expect(PLUGIN_CONNECTION_STATUS_MAX_IDS).toBe(50);
    expect(PLUGIN_CONNECTION_ID_MAX_LENGTH).toBe(120);
  });

  test("splits durable state into top-level and namespaced tools with fixed targets", () => {
    expect([UPDATE_MEMORY_TOOL.name, UPDATE_ROUTINE_TOOL.name]).toEqual(["UpdateMemory", "UpdateRoutine"]);
    expect(NATIVE_TOOL_NAMES).not.toContain("update_state");
    expect(CURSOR_TOOL_NAMES).not.toContain("update_state");
    expect(
      [UPDATE_SKILL_TOOL, UPDATE_PROFILE_TOOL, UPDATE_AVATAR_TOOL, DISCONNECT_CHANNEL_TOOL].map((tool) => tool.name)
    ).toEqual(["UpdateSkill", "UpdateProfile", "UpdateAvatar", "DisconnectChannel"]);
    expect(STATE_TOOL_TARGETS).toEqual({
      UpdateMemory: "memory",
      UpdateRoutine: "routine",
      UpdateSkill: "skill",
      UpdateProfile: "profile",
      UpdateAvatar: "avatar",
      DisconnectChannel: "channel",
    });
    expect(isStateTool("update_state")).toBe(false);
    expect(isStateTool("UpdateProject")).toBe(false);
    for (const name of Object.keys(STATE_TOOL_TARGETS)) {
      expect(isStateTool(name)).toBe(true);
      const schema = referenceTool(name).inputSchema as { properties: Record<string, unknown> };
      expect(schema.properties).not.toHaveProperty("target");
      // Every advertised argument survives the argument parser.
      expect(Object.keys(normalizeMainToolArguments(name, {
        ...{ UpdateMemory: { action: "write", fact: "x", type: "journal" }, UpdateRoutine: { action: "pause", id: "r" }, UpdateSkill: { action: "delete", id: "s" },
          UpdateProfile: {}, UpdateAvatar: { action: "clear" }, DisconnectChannel: { platform: "slack" } }[name],
        target: "memory",
      }))).not.toContain("target");
    }
    const memory = UPDATE_MEMORY_TOOL.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(memory.properties.action?.enum).toEqual(["write", "forget"]);
    expect(memory.properties.type?.enum).toEqual(["profile", "journal", "shared_profile", "shared_journal"]);
    expect(Object.keys(memory.properties)).toEqual(["action", "fact", "type"]);
    expect(memory.required).toEqual(["action", "fact", "type"]);
    expect(UPDATE_MEMORY_TOOL.description).toStartWith(
      "Change your durable memory. Each memory type below holds one kind of fact. Save a fact to the type meant for it, and leave out a fact no type is meant for:\n- profile: "
    );
    expect(UPDATE_MEMORY_TOOL.description).toContain("UpdateSkill, UpdateProfile, UpdateAvatar, DisconnectChannel.");
    expect(UPDATE_MEMORY_TOOL.description).not.toContain("memory folder");
    const routine = UPDATE_ROUTINE_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> };
    expect(routine.properties.action?.enum).toEqual(["create", "get", "update", "pause", "resume", "delete"]);
    // Routine writes apply directly; no confirmation card exists.
    expect(UPDATE_ROUTINE_TOOL.description).not.toContain("confirm");
    expect(UPDATE_ROUTINE_TOOL.description).toContain("- create: name, prompt, and schedule or trigger. get: id; returns the saved prompt and trigger. update: id plus only the fields to change. pause, resume, delete: id.\nBefore you change a routine's prompt or describe what it does, get it and work from the saved text, not from memory.");
    expect(UPDATE_ROUTINE_TOOL.description).toContain("folder ids are listed under Scheduled routines in your prompt, which shows no prompts.");
    expect(UPDATE_ROUTINE_TOOL.description).toEndWith("Don't ask first, and don't retry a denied write.");
    expect(UPDATE_ROUTINE_TOOL.description).not.toMatch(/Cursor|JoinMeeting|automation_status|timing/);
    // The schema names trigger types only; the skill and the invalid-trigger reply carry the shapes.
    const listener = {
      type: "object",
      properties: { type: { type: "string", enum: ["slack", "github", "origin", "microsoftTeams", "linear", "sentry", "pagerduty", "email", "webhook", "cron", "group"] } },
      required: ["type"], additionalProperties: {},
    };
    expect(routine.properties.trigger as unknown).toEqual({
      anyOf: [listener, { type: "array", items: listener, minItems: 1 }],
      description: "An event listener instead of schedule. Fields depend on type; see Trigger shapes in the routines skill.",
    });
    expect(Object.keys((UPDATE_PROFILE_TOOL.inputSchema as { properties: object }).properties)).toEqual([
      "name", "description", "title", "avatar_shape", "avatar_color", "hidden_from_sidebar", "notify_on_updates", "drafting_disabled",
    ]);
    expect(
      Schema.decodeUnknownSync(UpdateMemoryToolInput)({
        action: "write",
        fact: "The user prefers concise status updates.",
        type: "shared_profile",
      })
    ).toEqual({
      action: "write",
      fact: "The user prefers concise status updates.",
      type: "shared_profile",
    });
    expect(() => Schema.decodeUnknownSync(UpdateMemoryToolInput)({ action: "write", fact: "x" })).toThrow();
    expect(() => Schema.decodeUnknownSync(UpdateMemoryToolInput)({ action: "write", fact: "x", type: "note" })).toThrow();
    expect(
      Schema.decodeUnknownSync(UpdateRoutineToolInput)({
        action: "create",
        name: "Daily brief",
        prompt: "Send a concise morning brief.",
        schedule: "@daily",
      })
    ).toMatchObject({ action: "create", schedule: "@daily" });
    expect(Schema.decodeUnknownSync(UpdateProfileToolInput)({ title: "", hidden_from_sidebar: true })).toEqual({
      title: "",
      hidden_from_sidebar: true,
    });
    expect(() => normalizeMainToolArguments("UpdateMemory", { action: "create", fact: "x", type: "profile" })).toThrow(
      "UpdateMemory only writes or forgets memory. Routines have their own UpdateRoutine tool."
    );
    expect(() => normalizeMainToolArguments("UpdateMemory", { action: "write", fact: "x", type: "log" })).toThrow(
      "UpdateMemory: pick the memory type it belongs in: profile, journal, shared_profile, shared_journal."
    );
    expect(() => normalizeMainToolArguments("UpdateMemory", { action: "write", fact: "x" })).toThrow(
      "UpdateMemory: pick the memory type it belongs in"
    );
    expect(() => normalizeMainToolArguments("UpdateProfile", { avatar_shape: "triangle" })).toThrow();
    // The apps draw robots; a mark shape they can't render would reset the robot to the default.
    expect(() => normalizeMainToolArguments("UpdateProfile", { avatar_shape: "cloud" })).toThrow("avatar_shape");
    expect(normalizeMainToolArguments("UpdateProfile", { avatar_shape: "owl" })).toEqual({ avatar_shape: "owl" });
    const shape = (UPDATE_PROFILE_TOOL.inputSchema as any).properties.avatar_shape;
    expect(shape.enum).toEqual([...ROBOT_AVATAR_SHAPES]);
    expect(shape.description).toBe("Your default robot, hidden while a custom picture is installed.");
    expect(normalizeMainToolArguments("UpdateMemory", { action: "write", fact: "x", type: "journal", scope: "user", tier: "note" })).toEqual({ action: "write", fact: "x", type: "journal" });
    expect(normalizeMainToolArguments("RecallMemory", { query: "launch", scope: "user", limit: 99 })).toEqual({ query: "launch" });
  });

  test("renders state results for the tool that ran", () => {
    expect(renderControlResult("UpdateProfile", { target: "profile", updated: true, settings: { target: "settings", updated: true } }, {
      name: "Ada", hidden_from_sidebar: true,
    })).toBe("Updated your name.\nUpdated your settings: hiddenFromSidebar.");
    expect(renderControlResult("UpdateProfile", { target: "profile", updated: true, settings_error: "storage unavailable" }, {
      title: "Designer", notify_on_updates: false,
    })).toBe("Updated your title.\nSettings not saved: storage unavailable");
    expect(renderControlResult("UpdateProfile", { target: "settings", updated: true }, { notify_on_updates: false })).toBe(
      "Updated your settings: notifyOnAgentUpdates."
    );
    expect(renderControlResult("UpdateSkill", { target: "skill", action: "write", id: "standup", name: "Standup", saved: true }, {
      action: "write",
    })).toBe('Saved skill "Standup" (id standup).');
    expect(renderControlResult("DisconnectChannel", { target: "channel", platform: "slack", disconnected: true }, { platform: "slack" })).toContain(
      "Disconnected slack."
    );
    // The installed file is the picture; the source the model passed is what it may delete.
    expect(renderControlResult("UpdateAvatar", {
      target: "avatar", action: "set", path: "downloads/pic.png", resolved_path: "/home/box/sand-data/bots/b1/avatar.png", updated: true,
    }, { action: "set", path: "downloads/pic.png" })).toBe("Updated your picture (avatar.png). Source pic.png can be deleted if you no longer need it.");
    expect(renderControlResult("UpdateAvatar", { target: "avatar", cleared: true }, { action: "clear" })).toBe(
      "Cleared your picture. It is back to the default."
    );
    // Refusals read as the reference's "Not saved" sentences, as ordinary results.
    expect(renderControlResult("UpdateAvatar", { target: "avatar", action: "clear", refused: "you already have the default picture." }, { action: "clear" })).toBe(
      "Not saved: you already have the default picture."
    );
    expect(renderControlResult("DisconnectChannel", { target: "channel", platform: "slack", refused: "slack is not connected." }, { platform: "slack" })).toBe(
      "Not saved: slack is not connected."
    );
    expect(renderControlResult("UpdateProfile", { target: "settings", action: "set", refused: 'only the user can turn drafts off. Nothing was changed. Tell them to click "Disable drafts for this Bot" on a draft card.' }, { drafting_disabled: true })).toBe(
      'Not saved: only the user can turn drafts off. Nothing was changed. Tell them to click "Disable drafts for this Bot" on a draft card.'
    );
    expect(renderControlResult("UpdateProfile", { target: "settings", updated: true }, { drafting_disabled: false })).toBe("Updated your settings: draftingDisabled.");
    expect(renderControlResult("UpdateProfile", { target: "profile", updated: true, settings: { target: "settings", refused: "nothing to change." } }, { title: "x", drafting_disabled: true })).toBe(
      "Updated your title.\nSettings not saved: nothing to change."
    );
    expect(renderControlResult("UpdateRoutine", { target: "routine", name: "Brief", folder: "brief", next_run_at: null, enabled: false }, {
      action: "pause", id: "brief",
    })).toBe('Paused routine "Brief" (folder brief).\nNext scheduled occurrence: none (paused).');
    const created = { target: "routine", name: "Brief", folder: "brief", enabled: true, timezone: "America/Los_Angeles",
      trigger: { type: "cron", schedule: "0 8 * * *" }, next_run_at: "2026-10-22T15:00:00.000Z" };
    expect(renderControlResult("UpdateRoutine", { ...created, delivery_nudge: true }, { action: "create" })).toBe([
      'Saved routine "Brief" (folder brief): Every day at 8:00 AM.',
      "Next scheduled occurrence: 10/22/2026, 8:00:00 AM PDT. Use this saved time if reporting the next run; do not calculate or guess a different time.",
      "Give the user a concise summary of what this routine does and where its result goes.",
    ].join("\n"));
    // A routine run gets no nudge; resuming reads like an update; deleting names no next run.
    expect(renderControlResult("UpdateRoutine", created, { action: "update", id: "brief" })).toStartWith('Updated routine "Brief" (folder brief): Every day at 8:00 AM.\nNext');
    expect(renderControlResult("UpdateRoutine", created, { action: "update", id: "brief" })).not.toContain("Give the user");
    expect(renderControlResult("UpdateRoutine", created, { action: "resume", id: "brief" }).split("\n")[0]).toBe('Updated routine "Brief" (folder brief): Every day at 8:00 AM.');
    expect(renderControlResult("UpdateRoutine", { ...created, enabled: false, next_run_at: null }, { action: "delete", id: "brief" })).toBe('Deleted routine "Brief" (folder brief).');
    expect(renderControlResult("UpdateRoutine", { ...created, trigger: { type: "cron", schedule: "36 10 21 10 *" } }, { action: "create" }).split("\n")[0])
      .toBe('Saved routine "Brief" (folder brief): Once October 21 at 10:36 AM.');
    const saved = { target: "routine", action: "get", name: "Brief", folder: "brief", enabled: true, prompt: "Summarize my inbox.\nPost it here." };
    expect(renderControlResult("UpdateRoutine", { ...saved, trigger: { type: "cron", schedule: "0 8 * * *" } }, { action: "get", id: "brief" })).toBe(
      'Routine "Brief" (folder brief), enabled.\nTrigger: Every day at 8:00 AM\nschedule: "0 8 * * *" (leave it out of an update unless the time itself changes)\nSaved prompt:\nSummarize my inbox.\nPost it here.'
    );
    const listener = { type: "slack", channel: "#eng", match: { kind: "mention" } };
    expect(renderControlResult("UpdateRoutine", { ...saved, enabled: false, trigger: listener }, { action: "get", id: "brief" }).split("\n").slice(0, 3)).toEqual([
      'Routine "Brief" (folder brief), paused.', `Trigger: ${describeTrigger(listener)}`, `trigger: ${JSON.stringify(listener)}`,
    ]);
    expect(renderControlResult("UpdateRoutine", { target: "routine", action: "get", refused: "a routine run can only read the routine that started it." }, { action: "get", id: "other" }))
      .toBe("Not read: a routine run can only read the routine that started it.");
    expect(renderControlResult("UpdateRoutine", { target: "routine", action: "create", refused: "a routine run cannot create another routine." }, { action: "create" }))
      .toBe("Not saved: a routine run cannot create another routine.");
    // Persisted history keeps its text; the retired name no longer formats anything.
    expect(renderControlResult("update_state", { target: "channel", disconnected: true, platform: "slack" }, {})).toBe(
      JSON.stringify({ target: "channel", disconnected: true, platform: "slack" })
    );
  });
});

describe("renamed first-party tools", () => {
  test("advertise what this deployment does", () => {
    const cookies = referenceTool("RequestCookieOriginApproval");
    expect(cookies.description).toContain("no approval dialog opens");
    expect(JSON.stringify(cookies)).not.toMatch(/Always allow|Approve once|approval dialog and wait|Already-granted/);
    const share = referenceTool("CreateBotShareJson");
    expect(share.description).toStartWith("Publish a new version of this bot's template");
    expect(share.description).not.toMatch(/Stage a draft|stays private|New templates are PUBLIC|fill-in placeholders|live geometric avatar/);
    const form = referenceTool("RequestUserForm");
    expect(form.description).toContain("Fields inside iframes (cross-origin ones included) and shadow roots are reachable: send the form for them instead of predicting a failure.");
    const boxHelp = referenceTool("request_box_help").description;
    expect(boxHelp).toContain("goes to RequestUserForm first when it is among your tools, embedded and cross-origin fields included; entering the card itself is that form. Hand off only when that tool is not offered, the step is not a typed field, or the host refused the form or reported a failed fill");
    expect(boxHelp).not.toContain("Secure Form");
    expect(form.description).not.toContain("Secure Form");
    expect(form.inputSchema.properties.fields.items.properties).not.toHaveProperty("default_value");
    expect(referenceTool("RemapUserFormTargets").description).toContain("right after a RequestUserForm receipt");
  });

  test("old snake_case names format nothing and parse nothing", () => {
    expect(renderControlResult("create_bot_share_json", { published: true, version: 2 }, {})).toBe(JSON.stringify({ published: true, version: 2 }));
    expect(renderControlResult("CreateBotShareJson", { published: true, version: 2 }, {})).toContain("version 2");
    for (const name of ["upload_file", "download_file", "request_user_form", "remap_user_form_targets", "create_bot_share_json", "import_chrome_cookies"])
      expect(() => referenceTool(name)).toThrow("No captured tool contract");
  });
});

describe("in-chat form results", () => {
  const shown = "Showed the form to the user; your turn is over. When they submit, the host fills the browser and resumes you with a per-field receipt (fill statuses only, never the submitted values). If they dismiss it, you'll be resumed with that outcome. If they choose to do the step on the screen instead, the host hands them the box directly (same as request_box_help) and you'll be resumed when they hand it back.";
  test("a shown form tells the model its turn is over and appends the dropped-field note", () => {
    expect(renderControlResult("RequestUserForm", { sent: true, channel_id: "c1", message_address: "t2s1" }, {})).toBe(shown);
    expect(renderControlResult("RequestUserForm", { sent: true, preflightNote: "NOTE: dropped" }, {})).toBe(`${shown}\n\nNOTE: dropped`);
  });

  test("a refused preparation is rebuilt from allowlisted kinds of the form's own fields", () => {
    const form = parseUserForm({ title: "Pay", instruction: "Card", domain: "shop.example", fields: [
      { id: "cc", label: "Card number", type: "text", secret: true, target: { kind: "selector", value: "#cc" } },
      { id: "zip", label: "ZIP", type: "text", target: { kind: "selector", value: "#zip" } },
    ] });
    const structural = userFormPreparationRefusal(form, { error: "form_preflight_failed", message: "SECRET-246810",
      fieldKinds: { cc: "in_unreachable_frame", zip: "in_closed_shadow", other: "target_missing", __proto__: "x" } });
    expect(structural).toBe([
      'The form "Pay" was NOT shown and nothing was asked of the user: the host preflighted every targeted field against the live page and ALL of them are structurally unreachable, so the fill would fail the same way after they typed.',
      "- cc: target is inside a frame the host could not inspect (still loading or unreadable)",
      "- zip: target is behind a closed shadow root the host cannot reach",
      "Re-issuing this form (same targets, or fresh label/selector targets into the same unreachable frame or closed shadow root) will be refused the same way. Hand the user the screen with request_box_help so they can complete the step directly.",
    ].join("\n"));
    expect(userFormPreparationRefusal(form, { error: "form_preflight_failed", fieldKinds: { cc: "SECRET-246810" } })).toBeUndefined();
    expect(userFormPreparationRefusal(form, { error: "form_preflight_failed", fieldKinds: { cc: "hidden_target" } }))
      .toStartWith("No requested fields are reachable on the page. The form was not shown and nothing was asked of the user. The host did not ask the user for these fields because their controls are unavailable: cc (hidden_target).");
    expect(userFormPreparationRefusal(form, { error: "form_driver_unavailable" })).toStartWith(
      'The form "Pay" was NOT shown and nothing was asked of the user: the host could not reach the box browser at request time');
  });
});
