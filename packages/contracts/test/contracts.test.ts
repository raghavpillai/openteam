// biome-ignore-all lint/suspicious/noThenProperty: The external Computer contract intentionally names its action sequence "then".

import { describe, expect, test } from "bun:test";
import { referenceTool } from "../src/tool-contracts";
import { Schema } from "effect";
import {
  CreateBotInput,
  CURSOR_TOOL_NAMES,
  CURSOR_TOOLS,
  NATIVE_TOOL_NAMES,
  NATIVE_TOOLS,
  ScreenActionInput,
  SendMessageInput,
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
  UpdateMemoryToolInput,
  UpdateProfileToolInput,
  UpdateRoutineToolInput,
  UploadAssetInput,
} from "../src";
import { normalizeMainToolArguments } from "../src/reference-main-parsers";
import { PLUGIN_WORKFLOW_HOST_CONTEXT } from "../src/plugin-workflows";
import { ROBOT_AVATAR_SHAPES } from "../src/robot-avatar";
import { parseUserForm, userFormPreparationRefusal } from "../src/user-forms";
import nativeToolsDocument from "../src/native-tools.json";
import toolReference from "../src/tool-reference.json";



describe("API contracts", () => {

  test("accepts a valid bot", () => {
    const value = Schema.decodeUnknownSync(CreateBotInput)({
      clientRequestId: "create-researcher-0001",
      name: "Researcher",
      color: "#4f7cff",
    });
    expect(value.name).toBe("Researcher");
  });

  test("rejects an empty message", () => {
    expect(() =>
      Schema.decodeUnknownSync(SendMessageInput)({
        content: "",
        clientId: "message-1",
      })
    ).toThrow();
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

  test("declares the current native tools; machine discovery is looked up", () => {
    expect(NATIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "SendToUser",
      "ReactToMessage",
      "ListSections",
      "RecallMemory",
      "UpdateMemory",
      "UpdateRoutine",
      "Shell",
      "Read",
      "Screenshot",
      "GetDynamicTools",
      "CallDynamicTool",
    ]);
    for (const tool of NATIVE_TOOLS) {
      const expected = referenceTool(tool.name);
      expect({name:tool.name,description:tool.description,inputSchema:tool.inputSchema}).toEqual(expected);
    }
    expect(NATIVE_TOOLS.some((tool) => tool.name === "AddMcpServer")).toBe(false);
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

  test("plugin host context keeps a workflow's confirmation steps", () => {
    // The main prompt asks first before consequential actions; plugin skills must not be told otherwise.
    expect(PLUGIN_WORKFLOW_HOST_CONTEXT).not.toMatch(/extra action approvals do not apply|Carry out the user's requested work directly|Ask only for information or authentication/);
    expect(PLUGIN_WORKFLOW_HOST_CONTEXT).toContain("A workflow's confirmation steps apply, alongside your own rules on asking first.");
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
      "CopyToBox", "CopyFromBox", "WebSearch", "WebFetch", "RequestUserForm", "RemapUserFormTargets", "DraftExternalMessage", "CreateBotShareJson",
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
    expect(memory.properties.action?.enum).toEqual(["write", "forget", "replace"]);
    expect(memory.properties.type?.enum).toEqual(["profile", "journal", "shared_profile", "shared_journal"]);
    expect(Object.keys(memory.properties)).toEqual(["action", "fact", "type", "id"]);
    expect(memory.required).toEqual(["action", "fact", "type"]);
    const routine = UPDATE_ROUTINE_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> };
    expect(routine.properties.action?.enum).toEqual(["create", "get", "update", "pause", "resume", "delete"]);
    // The schema names trigger types only; the skill and the invalid-trigger reply carry the shapes.
    const listener = {
      type: "object",
      properties: { type: { type: "string", enum: ["slack", "github", "origin", "microsoftTeams", "linear", "sentry", "pagerduty", "email", "webhook", "cron", "group"] } },
      required: ["type"],
    };
    expect(routine.properties.trigger as unknown).toEqual({
      anyOf: [listener, { type: "array", items: listener, minItems: 1 }],
      description: "An event listener instead of schedule. Fields depend on type; see Trigger shapes in the routines skill.",
    });
    expect(Object.keys((UPDATE_PROFILE_TOOL.inputSchema as { properties: object }).properties)).toEqual([
      "name", "description", "title", "avatar_shape", "avatar_color", "notify_on_updates", "drafting_disabled",
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
    });
    expect(() => normalizeMainToolArguments("UpdateMemory", { action: "create", fact: "x", type: "profile" })).toThrow(
      "UpdateMemory only writes, replaces or forgets memory. Routines have their own UpdateRoutine tool."
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
    expect(normalizeMainToolArguments("UpdateMemory", { action: "write", fact: "x", type: "journal", scope: "user", tier: "note" })).toEqual({ action: "write", fact: "x", type: "journal" });
    expect(normalizeMainToolArguments("RecallMemory", { query: "launch", scope: "user", limit: 99 })).toEqual({ query: "launch" });
  });

});

describe("in-chat form results", () => {
  const shown = "Showed the form to the user; your turn is over. When they submit, the host fills the browser and resumes you with a per-field receipt (fill statuses only, never the submitted values). If they dismiss it, you'll be resumed with that outcome. If they choose to do the step on the screen instead, the host hands them the box directly (same as request_box_help) and you'll be resumed when they hand it back.";

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
