import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CURSOR_TOOL_NAMES,
  CURSOR_TOOLS,
  NATIVE_TOOLS,
  ScreenActionInput,
  SendMessageInput,
  isStateTool,
  STATE_TOOL_TARGETS,
  UPDATE_PROFILE_TOOL,
  TaskInput,
  UploadAssetInput,
} from "../src";
import { normalizeMainToolArguments } from "../src/reference-main-parsers";
import { ROBOT_AVATAR_LABELS, ROBOT_AVATAR_SHAPES, normalizeRobotAvatarShape } from "../src/robot-avatar";
import { parentOnlyDispatchNotice } from "../src/subagent-dispatch";
import { parseTaskConfiguration, taskInference, taskUserInfo } from "../src/task-configuration";
import { referenceTool, taskToolContract } from "../src/tool-contracts";
import { parseUserForm, userFormPreparationRefusal } from "../src/user-forms";

describe("API contracts", () => {
  test("accepts canonical attachment references and rejects inline message bytes", () => {
    const attachment = { assetId: "a".repeat(64), fileName: "upload.png", mimeType: "image/png", byteSize: 12, kind: "image" as const };
    const send = Schema.decodeUnknownSync(SendMessageInput);
    expect(send({ content: "What is in this image?", clientId: "message-image-1", attachments: [attachment] })).toMatchObject({ attachments: [attachment] });
    expect(send({ content: "", clientId: "message-image-only-1", attachments: [attachment] })).toMatchObject({ content: "", attachments: [attachment] });
    expect(() => send({ content: "", clientId: "message-image-2", images: [{ url: "data:image/png;base64,AQID" }] })).toThrow();
    expect(Schema.decodeUnknownSync(UploadAssetInput)({ fileName: "upload.png", mimeType: "image/png", bytesBase64: "AQID" })).toMatchObject({ fileName: "upload.png", bytesBase64: "AQID" });
  });

  test("validates bounded graphical computer actions", () => {
    const screen = Schema.decodeUnknownSync(ScreenActionInput);
    expect(screen({ action: "click", x: 640, y: 400 })).toEqual({ action: "click", x: 640, y: 400 });
    expect(() => screen({ action: "click", x: 1280, y: 400 })).toThrow();
    expect(() => screen({ action: "key", keys: ["ctrl+l;rm"] })).toThrow();
  });

  test("declares the current native tools; machine discovery is looked up", () => {
    expect(NATIVE_TOOLS.map((tool) => tool.name)).toEqual(["SendToUser", "ReactToMessage", "ListSections", "RecallMemory", "UpdateMemory", "UpdateRoutine",
      "Shell", "Read", "Screenshot", "GetDynamicTools", "CallDynamicTool"]);
    for (const tool of NATIVE_TOOLS) {
      const expected = referenceTool(tool.name);
      expect({name:tool.name,description:tool.description,inputSchema:tool.inputSchema}).toEqual(expected);
    }
  });

  test("declares the supported Cursor-compatible subset including AwaitShell", () => {
    expect(CURSOR_TOOL_NAMES).toEqual([
      "AwaitShell", "CheckSubagent", "CreateAgent", "CreateChannel", "SendToAgent", "MessageSubagent", "StopSubagent", "Task", "request_box_help",
      "TodoWrite", "UpdateAgent", "UpdateChannel", "UpdateSkill", "UpdateProfile", "UpdateAvatar", "DisconnectChannel",
      "CopyToBox", "CopyFromBox", "WebSearch", "WebFetch", "RequestUserForm", "RemapUserFormTargets", "DraftExternalMessage", "CreateBotShareJson",
      "WakeParent",
    ]);
    for (const tool of CURSOR_TOOLS) {
      expect(tool.description).toEqual(referenceTool(tool.tool).description);
      expect(tool.inputSchema).toEqual(referenceTool(tool.tool).inputSchema);
    }
  });

  test("splits durable state into top-level and namespaced tools with fixed targets", () => {
    expect(STATE_TOOL_TARGETS).toEqual({ UpdateMemory: "memory", UpdateRoutine: "routine", UpdateSkill: "skill", UpdateProfile: "profile", UpdateAvatar: "avatar", DisconnectChannel: "channel" });
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
    expect(() => normalizeMainToolArguments("UpdateMemory", { action: "create", fact: "x", type: "profile" })).toThrow(
      "UpdateMemory only writes or forgets memory. Routines have their own UpdateRoutine tool."
    );
    expect(() => normalizeMainToolArguments("UpdateMemory", { action: "write", fact: "x", type: "log" })).toThrow(
      "UpdateMemory: pick the memory type it belongs in: profile, journal, shared_profile, shared_journal."
    );
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

test("robot IDs round-trip, normalize case and default unknown or retired names", () => {
  for (const shape of ROBOT_AVATAR_SHAPES) {
    expect(normalizeRobotAvatarShape(shape)).toBe(shape);
    expect(shape.length).toBeLessThanOrEqual(16);
    expect(ROBOT_AVATAR_LABELS[shape]).toBeTruthy();
  }
  expect(normalizeRobotAvatarShape(" HEX-VISOR ")).toBe("hex-visor");
  for (const value of [undefined, null, "", "unknown", "__proto__", "constructor", "circle", "cloud"]) expect(normalizeRobotAvatarShape(value)).toBe("chip");
});

test("parsers keep the reference arguments OpenTeam supports", () => {
  expect(normalizeMainToolArguments("ReactToMessage", { message_address: "t3u", emoji: "👍", end_turn: true })).toEqual({ message_address: "t3u", emoji: "👍", end_turn: true });
  const handoff = { instruction: "Sign in", domain: "example.com", idp_domain: "accounts.example.com", url: "https://app.example.com/login" };
  expect(normalizeMainToolArguments("request_box_help", handoff)).toEqual(handoff);
  expect(normalizeMainToolArguments("StopSubagent", { all: true })).toEqual({ all: true });
  expect(normalizeMainToolArguments("StopSubagent", { subagent_id: " sand-subagent-1 " })).toEqual({ subagent_id: "sand-subagent-1" });
  for (const invalid of [{}, { all: false }, { all: true, subagent_id: "sand-subagent-1" }])
    expect(() => normalizeMainToolArguments("StopSubagent", invalid), JSON.stringify(invalid)).toThrow("exactly one");
});
test("SendToUser refuses fields and files it would silently drop", () => {
  const refusal = (args: unknown) => {
    try { normalizeMainToolArguments("SendToUser", args); } catch (error) { return (error as Error).message; }
    throw new Error("accepted");
  };
  const others = 'Send every other file (PDF, document, spreadsheet, video) as its own SendToUser call with type:"attachment" and url (file:// or https://), one call per file.';
  expect(refusal({ type: "text", content: "hi", attachments: [{ url: "file:///workspace/a.pdf" }] })).toBe(
    `Invalid arguments:\nattachments: attachments is not a SendToUser field, so it would be silently dropped. Nothing was sent. Put images that go with your text in images on the type:text message. ${others}`
  );
  expect(refusal({ content: "hi", files: ["file:///workspace/a.pdf"] })).toStartWith("Invalid arguments:\nfiles: files is not a SendToUser field");
  // Field issues still come back beside the hint.
  expect(refusal({ type: "text", files: ["/workspace/a.pdf"] })).toBe(
    `Invalid arguments:\nfiles: files is not a SendToUser field, so it would be silently dropped. Nothing was sent. Put images that go with your text in images on the type:text message. ${others}\ncontent: content is required when type is text`
  );
  expect(normalizeMainToolArguments("SendToUser", { type: "text", content: "hi", attachments: [] })).toEqual({ type: "text", content: "hi" });
  expect(refusal({ type: "text", content: "hi", images: [{ url: "file:///workspace/report.pdf" }] })).toBe(
    `Invalid arguments:\nimages.0.url: each images url must be a picture that goes with your text, and this one is another kind of file, so nothing was sent. ${others}`
  );
  for (const url of ["file:///workspace/chart.png", "https://example.com/photo.JPG?x=1", "file:///workspace/logo.svg", "https://example.com/render"])
    expect(normalizeMainToolArguments("SendToUser", { type: "text", content: "hi", images: [{ url }] }).images).toEqual([{ url }]);
  expect(refusal({ type: "text", content: "hi", images: [{ url: "/workspace/chart.png" }] })).toBe(
    "Invalid arguments:\nimages.0.url: each images url must include a file:// or https:// scheme. For a file on your computer, put file:// before its absolute path (file:///workspace/chart.png) and send it again. Nothing was sent."
  );
  expect(refusal({ type: "attachment", url: "/workspace/report.pdf" })).toBe(
    "Invalid arguments:\nurl: url must include a file:// or https:// scheme when type is attachment. For a file on your computer, put file:// before its absolute path (file:///workspace/report.pdf) and send it again. Nothing was sent."
  );
  expect(refusal({ type: "attachment", url: "file:///workspace/a.pdf", content: "here" })).toBe(
    "Invalid arguments:\ncontent: content is only valid with type:text and cannot be sent on a type:attachment message. It would be silently dropped. Nothing was sent. Re-send as separate SendToUser calls, one per type: this field on its own properly-typed message (type:text), and any text as its own type:text message."
  );
});

const parseTask = Schema.decodeUnknownSync(TaskInput);
const task = { description: "Process files", prompt: "Read /workspace/input.zip using Shell" };
test("Task rejects non-media and too many attachments before dispatch, while shared-file prompts remain valid", () => {
  for (const file of ["/workspace/input.zip", "/workspace/report.pdf", "/workspace/a.csv", "/workspace/readme.txt", "/workspace/no-extension"])
    expect(() => parseTask({ ...task, file_attachments: [file] })).toThrow("shared filesystem path");
  expect(parseTask(task)).toEqual(task);
  expect(parseTask({ ...task, file_attachments: [] }).file_attachments).toEqual([]);
  const paths = Array.from({ length: 65 }, (_, i) => `/workspace/image-${i}.png`);
  expect(parseTask({ ...task, file_attachments: paths.slice(0, 64) }).file_attachments).toHaveLength(64);
  expect(() => parseTask({ ...task, file_attachments: paths })).toThrow("A subagent can take at most 64 images in file_attachments. Attach fewer and try again.");
});

test("Task profiles and model arguments cannot override server inference, and ambiguous profiles cannot be saved", () => {
  const profile = (name: string, providerId: string, modelId: string, reasoning: string) => ({ name, description: name, providerId, modelId, reasoning });
  const config = parseTaskConfiguration({ executorProfiles: [profile("quick", "openai", "small-model", "low"), profile("deep", "anthropic", "large-model", "high")], defaultExecutorProfile: "quick" });
  expect(taskToolContract(config).inputSchema.properties.model).toBeUndefined();
  expect(taskUserInfo(config)).not.toContain("available_subagent_models");
  for (const reasoning of ["off", "high"] as const)
    for (const subagent_type of ["executor", "computerUse", "videoReview", "watchVideo"])
      for (const model of [undefined, "quick", "deep", "unconfigured", "provider/model"])
        for (const resume of [undefined, "previous"]) {
          const authority = { providerId: "openai", modelId: "parent-model", reasoning };
          expect(taskInference(config, { model, subagent_type, resume }, authority)).toEqual(authority);
        }
  const [first] = config.executorProfiles;
  for (const input of [null, {}, { ...config, executorProfiles: undefined }, { ...config, browserWorker: true }, { ...config, defaultExecutorProfile: "missing" },
    { ...config, executorProfiles: [first, first] }, { ...config, executorProfiles: [{ ...first, reasoning: "imaginary" }] },
    { ...config, executorProfiles: [{ ...first, name: "provider/model" }] }])
    expect(() => parseTaskConfiguration(input)).toThrow();
});

test("a dispatch naming tools the executor lacks tells the parent to do those steps itself", () => {
  const prompt = "Research the flights, then UpdateMemory with the preference, SendToUser the summary, call DraftExternalMessage for the email, and UpdateRoutine to check daily. Use WebSearch and TodoWrite. Also SendToAgent the result.";
  const parent = "Only the parent talks to the user; a Task subagent reports back in its final message.";
  const owned = "Memory, routines, tasks, and the bot's profile change only through the parent, which owns the conversation.";
  expect(parentOnlyDispatchNotice({ subagentType: "executor", prompt })).toBe([
    "<system_reminder>",
    "This dispatch names DraftExternalMessage, SendToAgent, SendToUser, TodoWrite, UpdateMemory, UpdateRoutine, which the executor subagent does not have, so it cannot do those steps.",
    `- DraftExternalMessage: ${parent}`,
    "- SendToAgent: Messages under the user's name need approval that only the parent can collect.",
    `- SendToUser: ${parent}`,
    "- TodoWrite: Task subagents don't start subagents of their own; the parent fans work out.",
    `- UpdateMemory: ${owned}`,
    `- UpdateRoutine: ${owned}`,
    "If the task needs them, do those steps yourself in this turn, before you end it. The subagent still runs and reports back on the rest.",
    "</system_reminder>",
  ].join("\n"));
});
