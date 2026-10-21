import { describe, expect, test } from "bun:test";
import { BROWSER_USE_TOOLS } from "../src/browser/use";
import { RuntimeTools } from "../src/runtime/tools";
import type { ActiveTurn } from "../src/runtime/types";
import { objectToolSchema } from "../src/tool-schema";
import reference from "../../../packages/contracts/src/tool-reference.json";
import { referenceTool } from "@openteam/contracts/tool-contracts";
import { normalizeMainToolArguments } from "@openteam/contracts/reference-main-parsers";
import { Type } from "typebox";
import { Schema } from "effect";
import { TodoWriteInput } from "@openteam/contracts";
import { Value } from "typebox/value";
import { taskToolContract } from "@openteam/contracts/tool-contracts";
import { enrichUserInfo } from "../src/runtime/prompt-context";
import { APP_SETTINGS_ANCHORS } from "@openteam/contracts/app-deep-links";
import { SETTINGS_ANCHORS } from "../../desktop/src/renderer/lib/app-deep-links";

// The baseline is extracted from the captured external tool catalog, not our handlers.
describe("captured tool contract wiring", () => {
  test("advertises one-item TODO merges while retaining replacement and empty-list bounds", () => {
    const schema = Type.Unsafe<Record<string, unknown>>(referenceTool("TodoWrite").inputSchema);
    const one = [{ id: "first", content: "First", status: "completed" }] as const;
    for (const [merge, todos, valid] of [[true, one, true], [false, one, false], [true, [], false], [false, [...one, { ...one[0], id: "second" }], true]] as const) {
      const input = { merge, todos };
      expect(Value.Check(schema, input)).toBe(valid);
      if (valid) expect(Schema.decodeUnknownSync(TodoWriteInput)(input)).toEqual(input);
      else expect(() => Schema.decodeUnknownSync(TodoWriteInput)(input)).toThrow();
    }
  });
  test("Task profiles and the graphical worker's tools agree with the advertised context", () => {
    const runtime = new RuntimeTools({} as never, "http://unused.invalid", "test", "/tmp", "/tmp");
    const taskConfiguration = { executorProfiles: [
      { name: "quick", description: "Small jobs", providerId: "openai", modelId: "fixture", reasoning: "low" as const },
    ] };
    const active = { runtimeProfile: "agent", pluginNamespaces: [], taskConfiguration } as unknown as ActiveTurn;
    const task = (runtime as any).dynamicCatalog(active).flatMap((namespace: any) => namespace.tools).find((tool: any) => tool.name === "Task");
    expect(task.inputSchema).toEqual(taskToolContract(taskConfiguration).inputSchema);
    const userInfo = enrichUserInfo("<user_info></user_info>", { cwd: "/tmp", transcriptPath: "/tmp/transcript", catalog: null, taskConfiguration });
    expect(userInfo).toContain("computerUse: Delegate a self-contained browser or desktop task");
    // Worker inference is server-controlled; profiles are not model-selectable.
    expect(userInfo).not.toContain("quick: Small jobs");
    const computer = runtime.customTools({ ...active, runtimeProfile: "subagent", subagentType: "computerUse" });
    expect(computer.some(tool => tool.name === "browser_snapshot")).toBe(true);
    expect(computer.some(tool => tool.name === "Computer")).toBe(true);
    for (const subagentType of ["executor", "computerUse"] as const) {
      const worker = { ...active, runtimeProfile: "subagent" as const, subagentType };
      expect(runtime.customTools(worker).some(tool => tool.name === "Task")).toBe(false);
      expect((runtime as any).dynamicCatalog(worker).flatMap((namespace: any) => namespace.tools).some((tool: any) => tool.name === "Task")).toBe(false);
    }
  });
  test("exposes the 81 active shared contracts through the actual model-facing profiles", () => {
    const runtime = new RuntimeTools({} as never, "http://unused.invalid", "test", "/tmp", "/tmp");
    // File transfers are offered beside a connected file service.
    const drive = { name: "google-drive", description: "Google Drive (default)", namespaceStatus: "ready", tools: [], fileTransfers: { upload: true, download: true } };
    const base = { runtimeProfile: "agent", pluginNamespaces: [drive] } as unknown as ActiveTurn;
    const catalog = [
      base,
      { ...base, requestSource: "automation" },
      { ...base, runtimeProfile: "subagent", subagentType: "computerUse" },
    ].flatMap((active) => [
      ...runtime
        .customTools(active as ActiveTurn)
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
      ...(active.runtimeProfile === "agent"
        ? (runtime as any).dynamicCatalog(active).flatMap((n: any) => n.tools)
        : []),
    ]);
    expect(Object.keys(reference)).toHaveLength(83);
    // The saved-login desktop tools are retired.
    const retired = ["ListCredentials", "GetCredentialProviderStatus"];
    for (const name of Object.keys(reference).filter((name) => !retired.includes(name))) {
      const visible = catalog.find((t) => t.name === name);
      expect(visible, name).toBeDefined();
      // Beside the browser tools, Computer's captured text gains their guidance and nothing else.
      const description = name === "Computer"
        ? visible.description.replace(/(scroll, and wait\.) For anything inside a web page.*then BackSpace\./, "$1")
        : visible.description.replace(/\n\nAvailable file connections this turn:\n[\s\S]*$/, "");
      expect(description, name).toBe(referenceTool(name).description);
      expect(visible.inputSchema, name).toEqual(referenceTool(name).inputSchema);
    }
    for (const excluded of ["GenerateImage", "CloudAgent", "request_scm_connect", ...retired])
      expect(catalog.some((t) => t.name === excluded)).toBe(false);
    const combined = runtime.customTools({ ...base, runtimeProfile: "subagent", subagentType: "computerUse" } as ActiveTurn)
      .find((t) => t.name === "Computer")!;
    expect(combined.description).toContain("and wait. For anything inside a web page, use the browser_* tools first.");
  });

  test("serves the captured browser contracts unchanged; press-and-hold lives on Computer", () => {
    expect(BROWSER_USE_TOOLS).toHaveLength(18);
    for (const tool of BROWSER_USE_TOOLS) expect(tool, tool.name).toEqual((reference as any)[tool.name]);
    expect((reference.browser_click.inputSchema.properties as any).holdDurationMs).toBeUndefined();
    expect(reference.Computer.inputSchema.properties.holdDurationMs.maximum).toBe(30_000);
  });

  test("SendToUser keeps the captured concise instructions, drops features OpenTeam lacks, and lists the app's real links", () => {
    const actual = referenceTool("SendToUser");
    const captured = reference.SendToUser.description;
    expect(actual.description).toStartWith('Send a message to the user. Follow "How a turn works" in your instructions');
    for (const kept of [
      '"Autonomy" and "Asking for decisions" before asking the user anything.',
      'Say "done" only once the end state is verified; otherwise name the actual state (drafted, sent, waiting, blocked).',
      "never a pointer to an earlier message or process notes.",
      "just attempt the action and let the OS show its own dialog; don't announce it or invent a permission card.",
      "a login you can't fill) goes to request_box_help.",
      "If this chat can't take one, the tool says who should continue where; relay that in text.",
      "Never write plugin links: InstallPlugin if missing, AuthenticateMcpServer if needsAuth.",
      "Label each link with its target's real name.",
    ]) {
      expect(captured, kept).toContain(kept);
      expect(actual.description, kept).toContain(kept);
    }
    // No voice memos, cloud agents, team-bot plugin secrets, categorical sign-in handovers, or missing app pages.
    for (const absent of ["voice memo", "voice_memo", "cursor-agent", "cloud agent", "plugin_id", "SSO", "2FA", "bot-template", "app/v1/agent", "app/v1/sidebar", "update-channel", "reset-computer"])
      expect(actual.description, absent).not.toContain(absent);
    expect(actual.description).toContain("or with connector and field instead of name, that connector's credential file.");
    const anchors = /<anchor> one of: ([^.]+)\./.exec(actual.description)![1]!.split(", ");
    expect(anchors).toEqual([...APP_SETTINGS_ANCHORS]);
    expect(anchors).toEqual([...SETTINGS_ANCHORS]);
    expect(actual.description).toContain(`settings?id=${anchors.find((anchor) => anchor === "web-search-provider")})`);
    expect(actual.inputSchema.properties.type.enum).toEqual(["text", "attachment", "widget", "secret-request"]);
    expect(actual.inputSchema.properties.type.description).not.toContain("cursor-agent");
    for (const removed of ["bcId", "credential", "voice_memo"]) expect(actual.inputSchema.properties).not.toHaveProperty(removed);
    expect(actual.inputSchema.properties.secret.properties).not.toHaveProperty("plugin_id");
    expect(actual.inputSchema.properties.url.description).not.toContain("voice memo");
    expect(actual.inputSchema.properties.channel.description).not.toContain("thread ts");
    expect(actual.inputSchema.properties.content.description).toContain("[words](sand-msg:<address>)");
    expect(actual.inputSchema.properties.end_turn.description).toBe("True ends the turn once this send succeeds.");
    // The advertised default type is what the parser applies.
    expect(actual.inputSchema.required).toBeUndefined();
    expect(normalizeMainToolArguments("SendToUser", { content: "Hi" })).toMatchObject({ type: "text", content: "Hi" });
  });

  test("the advertised secret alternatives agree with the SendToUser parser", () => {
    const schema = Type.Unsafe<Record<string, unknown>>(referenceTool("SendToUser").inputSchema);
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ label: "API token", name: "API_TOKEN" }, true],
      [{ label: "API token", name: "API_TOKEN", scope: "personal" }, true],
      [{ label: "API token", connector: "search", field: "apiKey" }, true],
      [{ label: "API token" }, false],
      [{ label: "API token", connector: "search" }, false],
      [{ label: "API token", field: "apiKey" }, false],
      [{ label: "API token", name: "API_TOKEN", connector: "search" }, false],
      [{ label: "API token", name: "API_TOKEN", field: "apiKey" }, false],
      [{ label: "API token", name: "API_TOKEN", connector: "search", field: "apiKey" }, false],
      [{ name: "API_TOKEN" }, false],
      [{ label: "API token", name: "API_TOKEN", scope: "unknown" }, false],
    ];
    for (const [secret, valid] of cases) {
      const input = { type: "secret-request", secret };
      expect(Value.Check(schema, input), JSON.stringify(secret)).toBe(valid);
      if (valid) expect(normalizeMainToolArguments("SendToUser", input)).toMatchObject(input);
      else expect(() => normalizeMainToolArguments("SendToUser", input)).toThrow();
    }
  });

  test("distinguishes an omitted required list from an explicit empty list", () => {
    expect(objectToolSchema({})).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(objectToolSchema({}, [])).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});
