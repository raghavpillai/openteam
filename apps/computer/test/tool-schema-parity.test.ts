import { describe, expect, test } from "bun:test";
import { BROWSER_USE_TOOLS } from "../src/browser/use";
import { RuntimeTools } from "../src/runtime/tools";
import type { ActiveTurn } from "../src/runtime/types";
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
    const userInfo = enrichUserInfo("<user_info></user_info>", { cwd: "/tmp", catalog: null, taskConfiguration });
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
    // Messages tools are listed while a connected Mac has Messages on.
    const base = { runtimeProfile: "agent", pluginNamespaces: [drive], messagesAvailable: true } as unknown as ActiveTurn;
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

  test("SendToUser lists exactly the app's settings links and applies its advertised default type", () => {
    const actual = referenceTool("SendToUser");
    const anchors = /<anchor> one of: ([^.]+)\./.exec(actual.description)![1]!.split(", ");
    expect(anchors).toEqual([...APP_SETTINGS_ANCHORS]);
    expect(anchors).toEqual([...SETTINGS_ANCHORS]);
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
});
