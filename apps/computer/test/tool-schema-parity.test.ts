import { describe, expect, test } from "bun:test";
import { BROWSER_USE_TOOLS } from "../src/browser/use";
import { RuntimeTools } from "../src/runtime/tools";
import type { ActiveTurn } from "../src/runtime/types";
import { objectToolSchema } from "../src/tool-schema";
import reference from "../../../packages/contracts/src/tool-reference.json";
import { referenceTool, SEND_TO_USER_BATCH_GUIDANCE } from "@openteam/contracts/tool-contracts";
import { READ_SIBLING_THREAD_TOOL } from "@openteam/contracts/sibling-threads";
import { normalizeMainToolArguments } from "@openteam/contracts/reference-main-parsers";
import { Type } from "typebox";
import { Schema } from "effect";
import { TodoWriteInput } from "@openteam/contracts";
import { Value } from "typebox/value";
import { taskToolContract } from "@openteam/contracts/tool-contracts";
import { enrichUserInfo } from "../src/runtime/prompt-context";

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
  test("Task profiles and split/combined worker tools agree with the advertised context", () => {
    const runtime = new RuntimeTools({} as never, "http://unused.invalid", "test", "/tmp", "/tmp");
    for (const combinedComputerUse of [true, false]) {
      const taskConfiguration = { combinedComputerUse, executorProfiles: [
        { name: "quick", description: "Small jobs", providerId: "openai", modelId: "fixture", reasoning: "low" as const },
      ] };
      const active = { runtimeProfile: "agent", pluginNamespaces: [], taskConfiguration } as unknown as ActiveTurn;
      const task = (runtime as any).dynamicCatalog(active).flatMap((namespace: any) => namespace.tools).find((tool: any) => tool.name === "Task");
      expect(task.inputSchema).toEqual(taskToolContract(taskConfiguration).inputSchema);
      const userInfo = enrichUserInfo("<user_info></user_info>", { cwd: "/tmp", transcriptPath: "/tmp/transcript", namespaces: [], taskConfiguration });
      expect(userInfo.includes("browserUse:")).toBe(!combinedComputerUse);
      expect(userInfo).toContain("quick: Small jobs");
      const computer = runtime.customTools({ ...active, runtimeProfile: "subagent", subagentType: "computerUse" });
      expect(computer.some(tool => tool.name === "browser_snapshot")).toBe(combinedComputerUse);
      expect(computer.some(tool => tool.name === "Computer")).toBe(true);
      const legacyBrowser = runtime.customTools({ ...active, runtimeProfile: "subagent", subagentType: "browserUse" });
      expect(legacyBrowser.some(tool => tool.name === "browser_snapshot")).toBe(true);
      for (const subagentType of ["executor", "computerUse", "browserUse"] as const) {
        const worker = { ...active, runtimeProfile: "subagent" as const, subagentType };
        expect(runtime.customTools(worker).some(tool => tool.name === "Task")).toBe(false);
        expect((runtime as any).dynamicCatalog(worker).flatMap((namespace: any) => namespace.tools).some((tool: any) => tool.name === "Task")).toBe(false);
      }
    }
  });
  test("exposes all 74 shared contracts through the actual model-facing profiles", () => {
    const runtime = new RuntimeTools({} as never, "http://unused.invalid", "test", "/tmp", "/tmp");
    const base = { runtimeProfile: "agent", pluginNamespaces: [] } as unknown as ActiveTurn;
    const catalog = [
      base,
      { ...base, requestSource: "automation" },
      ...["browserUse", "computerUse"].map((subagentType) => ({
        ...base,
        runtimeProfile: "subagent",
        subagentType,
      })),
    ].flatMap((active) => [
      ...runtime
        .customTools(active as ActiveTurn)
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
      ...(active.runtimeProfile === "agent"
        ? (runtime as any).dynamicCatalog(active).flatMap((n: any) => n.tools)
        : []),
    ]);
    expect(Object.keys(reference)).toHaveLength(74);
    for (const name of Object.keys(reference)) {
      const visible = catalog.find((t) => t.name === name);
      expect(visible, name).toBeDefined();
      expect(visible.description, name).toBe(referenceTool(name).description);
      expect(visible.inputSchema, name).toEqual(referenceTool(name).inputSchema);
    }
    for (const excluded of ["GenerateImage", "CloudAgent", "request_scm_connect"])
      expect(catalog.some((t) => t.name === excluded)).toBe(false);
  });

  test("preserves the captured graphical schemas including held clicks", () => {
    expect(BROWSER_USE_TOOLS).toHaveLength(18);
    // File upload is an OpenTeam extension; the captured 15 tools retain their schemas.
    const captured = BROWSER_USE_TOOLS.filter((tool) => !["browser_file_upload", "browser_fill_form", "browser_find"].includes(tool.name));
    expect(captured).toHaveLength(15);
    for (const tool of captured) {
      expect(tool.inputSchema).toEqual((reference as any)[tool.name].inputSchema);
      if (["browser_navigate", "browser_click"].includes(tool.name)) {
        expect(tool.description).toContain("page text and current element refs");
        expect(tool.description).not.toContain("with a screenshot");
      } else expect(tool).toEqual((reference as any)[tool.name]);
    }
    expect(reference.browser_click.inputSchema.properties.holdDurationMs.maximum).toBe(30_000);
    expect(reference.browser_mouse_click_xy.inputSchema.properties.holdDurationMs.maximum).toBe(
      30_000
    );
  });

  test("excluding cloud-agent delivery preserves every other SendToUser instruction", () => {
    const captured = reference.SendToUser.description;
    const actual = referenceTool("SendToUser");
    const identity = (text: string) =>
      text.replaceAll("Grok Bot", "OpenTeam").replaceAll("grokbot://", "openteam://");
    const beforeCloudAgent = captured.slice(0, captured.indexOf('Use {"type":"cursor-agent"'));
    const afterCloudAgent = captured.slice(captured.indexOf('Use {"type":"widget"'));
    expect(actual.description).toBe(
      identity(beforeCloudAgent + afterCloudAgent) +
        " OpenTeam also supports secret {label,connector,field} for connector credentials, and scope:bot|personal for named environment secrets. " + SEND_TO_USER_BATCH_GUIDANCE
    );
    expect(actual.description).not.toContain('"cursor-agent"');
    expect(actual.inputSchema.properties.type.enum).toEqual([
      "text", "attachment", "widget", "secret-request", "credential-request",
    ]);
    expect(actual.inputSchema.properties.type.description).toBe(
      "text for chat messages, attachment for actual files or standalone media, widget for an interactive question with selectable options, secret-request to ask the user for a credential through a secure masked input (never a chat paste), credential-request to ask the user to approve one-time browser fill of a saved login."
    );
    expect(actual.inputSchema.properties).not.toHaveProperty("bcId");
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

  test("sibling history is discoverable by parents and absent from subagent catalogs", () => {
    const runtime=new RuntimeTools({} as never,"http://unused.invalid","test","/tmp","/tmp");
    const base={runtimeProfile:"agent",pluginNamespaces:[]} as unknown as ActiveTurn;
    const tools=(active:ActiveTurn)=>(runtime as any).dynamicCatalog(active).flatMap((namespace:any)=>namespace.tools);
    const sibling=tools(base).find((tool:any)=>tool.name==="read_sibling_thread");
    expect(sibling.description).toBe(READ_SIBLING_THREAD_TOOL.description);
    expect(sibling.inputSchema).toEqual(READ_SIBLING_THREAD_TOOL.inputSchema);
    expect(sibling.decodeArguments({session_id:" sibling "})).toEqual({session_id:"sibling",limit:20});
    expect(()=>sibling.decodeArguments({session_id:"sibling",limit:51})).toThrow();
    expect(tools({...base,runtimeProfile:"subagent",subagentType:"executor"}).some((tool:any)=>tool.name==="read_sibling_thread")).toBe(false);
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
