import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NATIVE_TOOL_NAMES } from "@openteam/contracts";
import { BROWSER_USE_TOOLS } from "../../src/browser/use";
import { BotCompactionArchiveStore, BotCompactionCoordinator } from "../../src/bot-compaction";
import {
  CLOSING_SEND_NUDGE_PROMPT,
  ComputerRuntime,
  isDeliveryOwed,
  modelVisibleSummaryTools,
  REPLY_NUDGE_PROMPT,
} from "../../src/runtime";

const runtimeTools = () => (new ComputerRuntime() as unknown as { tools: unknown }).tools;

test('background status evidence comes only from active server records', async () => {
  const runtime = runtimeTools() as any;
  const previousFetch = globalThis.fetch;
  const pending = {subagent_id: 'worker', status: 'running', run_status: 'running'};
  const fixtures: Array<[unknown, boolean]> = [
    [pending, true],
    [{...pending, status: 'queued', run_status: null}, true],
    [{subagents: [pending]}, true],
    [{...pending, run_status: 'failed'}, false],
    [{...pending, status: 'completed'}, false],
    [{subagents: [pending, {...pending, status: 'completed'}]}, false],
    [{subagents: []}, false],
    ['No background subagents are running right now.', false],
    ['The worker is running', false],
  ];
  try {
    for (const [body, expected] of fixtures) {
      globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
      const result = await runtime.callControlPlaneTool({}, 'check', 'CheckSubagent', {});
      expect(result.details.pendingBackgroundWork).toBe(expected);
    }
  } finally { globalThis.fetch = previousFetch; }
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const turnRequest = (overrides: Record<string, unknown> = {}) => ({
  runId: crypto.randomUUID(),
  botId: crypto.randomUUID(),
  contextSessionId: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  sessionPath: null,
  content: "test",
  clientMessageId: crypto.randomUUID(),
  cwd: "/workspace",
  instructions: "system",
  model: "openai-codex/gpt-5.5",
  reasoning: "high",
  channelId: crypto.randomUUID(),
  deliveryId: null,
  ...overrides,
});

/** A connected Drive account: UploadFile and DownloadFile are offered only beside one. */
const driveNamespace = { name: "google-drive", description: "Google Drive (default)", namespaceStatus: "ready", tools: [], fileTransfers: { upload: true, download: true } };

const workerTurn = (subagentType: string | null, overrides: Record<string, unknown> = {}) => ({
  subagentType,
  runtimeProfile: subagentType ? "subagent" : "agent",
  pluginNamespaces: [driveNamespace],
  ...overrides,
}) as any;

const toolNames = (subagentType: string | null) => {
  const runtime = runtimeTools() as unknown as {
    customTools(active: { subagentType: typeof subagentType }): Array<{ name: string }>;
  };
  return runtime.customTools(workerTurn(subagentType)).map((tool) => tool.name);
};

const toolDescriptions = (subagentType: "computerUse") => {
  const runtime = runtimeTools() as unknown as {
    customTools(active: { subagentType: typeof subagentType }): Array<{
      name: string;
      description: string;
    }>;
  };
  return Object.fromEntries(
    runtime.customTools(workerTurn(subagentType)).map((tool) => [tool.name, tool.description])
  );
};

const dynamicToolNames = (namespace: string) => {
  const runtime = runtimeTools() as unknown as {
    dynamicCatalog(active: {
      runtimeProfile: "agent";
      pluginNamespaces: [];
    }): Array<{ name: string; tools: Array<{ name: string }> }>;
  };
  return (
    runtime
      .dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] })
      .find((candidate) => candidate.name === namespace)
      ?.tools.map((tool) => tool.name) ?? []
  );
};

const subagentDynamicToolNames = (namespace: string) => {
  const runtime = runtimeTools() as unknown as {
    dynamicCatalog(active: {
      runtimeProfile: "subagent";
      pluginNamespaces: [];
    }): Array<{ name: string; tools: Array<{ name: string }> }>;
  };
  return (
    runtime
      .dynamicCatalog({ runtimeProfile: "subagent", pluginNamespaces: [] })
      .find((candidate) => candidate.name === namespace)
      ?.tools.map((tool) => tool.name) ?? []
  );
};

describe("specialized subagent tool surfaces", () => {
  test.each(["videoReview", "watchVideo"])("%s reviews supplied media without tools", (subagentType) => {
    expect((runtimeTools() as any).customTools({ subagentType })).toEqual([]);
  });

  test("image generation is removed while unconfigured search remains discoverable", () => {
    for (const names of [dynamicToolNames("cursor"), subagentDynamicToolNames("cursor")]) {
      expect(names).not.toContain("GenerateImage");
      expect(names).toContain("WebSearch");
      expect(names).toContain("WebFetch");
    }
  });

  test("uses Bot's exact delivery nudges only for user-facing wake sources", () => {
    expect(REPLY_NUDGE_PROMPT).toContain("ack ≠ delivery");
    expect(REPLY_NUDGE_PROMPT).toEndWith("they just keep seeing silence.");
    expect(CLOSING_SEND_NUDGE_PROMPT).toEndWith(
      "continue it and send the result once you have it."
    );
    for (const source of ["turn", "handoff-resume", "broadcast", "connector"] as const) {
      expect(isDeliveryOwed(source)).toBe(true);
    }
    for (const source of ["agent", "automation", "event", "background-revival"] as const) {
      expect(isDeliveryOwed(source)).toBe(false);
    }
  });

  test("summary requests receive normal schemas but no executable tool functions", () => {
    const runtime = runtimeTools() as unknown as {
      customTools(active: { subagentType: null }): Array<{
        name: string;
        description: string;
        parameters: unknown;
        execute: unknown;
      }>;
    };
    const executable = runtime.customTools(workerTurn(null));
    const visible = modelVisibleSummaryTools(executable);
    expect(visible.map((tool) => tool.name)).toEqual(executable.map((tool) => tool.name));
    expect(visible.map((tool) => tool.description)).toEqual(
      executable.map((tool) => tool.description)
    );
    expect(visible.every((tool) => !("execute" in tool))).toBe(true);
  });

  test("computerUse receives Shell, Read, AwaitShell, Computer and the browser tools", () => {
    expect(toolNames("computerUse")).toEqual(["Shell", "Read", "AwaitShell", "Computer", ...BROWSER_USE_TOOLS.map(tool => tool.name)]);
  });

  test("the graphical worker drops exactly the disabled tools", () => {
    const runtime = runtimeTools() as any;
    const taskConfiguration = { executorProfiles: [], disabledToolIdentifiers: ["SHELL", "BROWSER_TABS", "OPENAI_COMPUTER_USE"] };
    expect(runtime.customTools(workerTurn("computerUse", { taskConfiguration })).map((tool: any) => tool.name)).toEqual([
      "Read",
      ...BROWSER_USE_TOOLS.map((tool) => tool.name).filter((name) => name !== "browser_tabs"),
    ]);
    const browserless = {
      executorProfiles: [],
      disabledToolIdentifiers: BROWSER_USE_TOOLS.map((tool) => tool.name.toUpperCase()),
    };
    expect(runtime.customTools(workerTurn("computerUse", { taskConfiguration: browserless })).map((tool: any) => tool.name)).toEqual([
      "Shell",
      "Read",
      "AwaitShell",
      "Computer",
    ]);
  });

  test("executor stays private while retaining execution and discovery tools", () => {
    const names = toolNames("executor");
    expect(names).not.toContain("SendToUser");
    expect(names).not.toContain("ReactToMessage");
    expect(names).not.toContain("UpdateMemory");
    expect(names).not.toContain("UpdateRoutine");
    expect(names).toContain("Shell");
    expect(names).toContain("Read");
    expect(names).toContain("GetDynamicTools");
    expect(names).toContain("CallDynamicTool");
    expect(names).not.toContain("Screenshot");
    const firstParty = (runtimeTools() as any).dynamicCatalog(workerTurn("executor")).find((namespace: any) => namespace.name === "cursor").tools.map((tool: any) => tool.name);
    expect(firstParty).toEqual([]);
  });

  test("executor and knowledgeWork call the web and shell-wait tools directly", async () => {
    const runtime = runtimeTools() as any;
    for (const subagentType of ["executor", "knowledgeWork"]) {
      const names = toolNames(subagentType);
      expect(names).toEqual(expect.arrayContaining(["Shell", "Read", "AwaitShell", "WebSearch", "WebFetch"]));
      expect(names).not.toContain("Screenshot");
      const cursor = runtime.dynamicCatalog(workerTurn(subagentType)).find((namespace: any) => namespace.name === "cursor").tools.map((tool: any) => tool.name);
      expect(cursor).not.toContain("WebSearch");
      expect(cursor).not.toContain("WebFetch");
      expect(cursor).not.toContain("AwaitShell");
      expect(cursor).not.toContain("TodoWrite");
    }
    const searches: string[] = [];
    runtime.webTools.search = async (query: string) => {
      searches.push(query);
      return { content: [{ type: "text", text: "results" }], details: {} };
    };
    const active = { ...workerTurn("executor"), runId: "run-1", pendingSteers: [] };
    const result = await runtime.executeOpenTeamTool(active, "call-1", "WebSearch", { search_term: "openteam" });
    expect(result.content[0].text).toBe("results");
    expect(searches).toEqual(["openteam"]);
    expect(toolNames("executor")).not.toContain("TodoWrite");
    expect(runtime.customTools(workerTurn("executor", { readOnly: true })).map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(["WebSearch", "WebFetch"])
    );
  });

  test("graphical workers wait on their background shells with AwaitShell", async () => {
    const runtime = runtimeTools() as any;
    const waits: unknown[] = [];
    runtime.nativeToolExecutor.awaitShell = async (input: unknown, _signal: unknown, scope: string) => {
      waits.push([input, scope]);
      return { content: [{ type: "text", text: "done" }], details: {} };
    };
    const active = { ...workerTurn("computerUse"), botId: "worker-bot", runId: "run-1", pendingSteers: [] };
    const result = await runtime.executeOpenTeamTool(active, "call-1", "AwaitShell", { shell_id: "7", block_until_ms: 1000 });
    expect(result.content[0].text).toBe("done");
    expect(waits).toEqual([[expect.objectContaining({ shell_id: "7" }), "worker-bot"]]);
  });

  test("the cursor namespace cues only the tools each agent has, under the reference header", () => {
    const runtime = runtimeTools() as any;
    const cursor = (active: Record<string, unknown>) => runtime.dynamicCatalog(active).find((namespace: any) => namespace.name === "cursor");
    const header = "First-party tools built into you, listed first: they are trusted and core to your job, so prefer one over an external namespace that covers the same need. Read a tool's schema with GetDynamicTools, then call it with CallDynamicTool in the cursor namespace.\n\nHere are some crucial instructions:\n";
    const main = cursor(workerTurn(null)).description;
    expect(main).toStartWith(header);
    for (const line of ["- ReadAgentActivity: Summarize", "- ReadTranscript: Read your full transcript", "- request_box_help: Hand your box's desktop", "- Task: Spawn subagents natively.", "- UploadFile: Send a box file to Google Drive or Gmail."])
      expect(main).toContain(line);
    expect(main.indexOf("- request_box_help:")).toBeLessThan(main.indexOf("- RequestUserForm:"));
    // An executor calls its file tools directly, so its cursor namespace has nothing to cue.
    expect(cursor(workerTurn("executor")).description).toBe(header.split("\n\n")[0]);
    // With nothing to send files to or fetch them from, neither tool is offered.
    const bare = cursor(workerTurn(null, { pluginNamespaces: [{ ...driveNamespace, name: "linear", fileTransfers: undefined }] }));
    expect(bare.tools.map((tool: any) => tool.name)).not.toContain("UploadFile");
    expect(bare.tools.map((tool: any) => tool.name)).not.toContain("DownloadFile");
    expect(bare.description).not.toContain("UploadFile");
    expect(cursor(workerTurn("executor", { pluginNamespaces: [] }))).toMatchObject({ tools: [], description: header.split("\n\n")[0] });
  });

  test("routine runs and connector workers upload and download files; graphical and media workers cannot", () => {
    const runtime = runtimeTools() as any;
    const cursor = (overrides: Record<string, unknown>) =>
      runtime.dynamicCatalog({ pluginNamespaces: [driveNamespace], ...overrides }).find((namespace: any) => namespace.name === "cursor").tools.map((tool: any) => tool.name);
    expect(cursor({ runtimeProfile: "agent", requestSource: "automation" })).toEqual(expect.arrayContaining(["UploadFile", "DownloadFile"]));
    // Executors and knowledgeWork call them directly, like the reference's statically offered tools.
    for (const subagentType of ["executor", "knowledgeWork"])
      for (const requestSource of ["agent", "automation"]) {
        const turn = workerTurn(subagentType, { requestSource });
        expect(runtime.customTools(turn).map((tool: any) => tool.name)).toEqual(expect.arrayContaining(["UploadFile", "DownloadFile"]));
        expect(cursor(turn)).not.toContain("UploadFile");
      }
    for (const subagentType of ["computerUse", "videoReview", "watchVideo"]) {
      const worker = cursor({ runtimeProfile: "subagent", subagentType });
      expect(worker).not.toContain("UploadFile");
      expect(worker).not.toContain("DownloadFile");
    }
  });

  test("discovering RequestUserForm lists the saved vault extra keys", async () => {
    const runtime = runtimeTools() as any;
    runtime.userForms.savedExtraKeys = async () => ["ktn"];
    const active = { ...workerTurn(null), cwd: "/tmp" };
    const text = (await runtime.getDynamicTools(active, "lookup", { namespace: "cursor", toolName: "RequestUserForm" })).content[0].text;
    expect(text).toContain("Vault extras: reuse the exact saved extra_key");
    expect(text).toContain('- \\"ktn\\"');
    expect(text).toContain('"tool": "RequestUserForm"');
  });

  test("workers get no memory or history tools; the main agent keeps them", () => {
    const runtime = runtimeTools() as unknown as {
      dynamicCatalog(active: { runtimeProfile: "agent" | "subagent"; subagentType?: string; pluginNamespaces: unknown[] }): Array<{ name: string; tools: Array<{ name: string; description: string }> }>;
      customTools(active: unknown): Array<{ name: string }>;
    };
    const cursor = (runtimeProfile: "agent" | "subagent", subagentType?: string) =>
      runtime.dynamicCatalog({ runtimeProfile, subagentType, pluginNamespaces: [driveNamespace] }).find((namespace) => namespace.name === "cursor")?.tools ?? [];
    for (const subagentType of ["executor", "knowledgeWork", "computerUse"]) {
      const names = [...cursor("subagent", subagentType), ...runtime.customTools(workerTurn(subagentType))].map((tool) => tool.name);
      for (const name of ["RecallMemory", "ReadTranscript", "ReadAgentActivity"]) expect(names, subagentType).not.toContain(name);
    }
    for (const subagentType of ["executor", "knowledgeWork"]) {
      expect(cursor("subagent", subagentType).map((tool) => tool.name)).toEqual([]);
    }
    const main = cursor("agent");
    expect(main.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ReadTranscript", "ReadAgentActivity"]));
    expect(main.find((tool) => tool.name === "ReadTranscript")!.description).toContain("Pass in=<id> for a Task subagent you dispatched");
    expect(runtime.customTools(workerTurn(null)).map((tool) => tool.name)).toContain("RecallMemory");
  });

  test("no agent has a Skill tool: knowledgeWork, like the main agent, reads its skills by path", () => {
    const runtime = runtimeTools() as unknown as { customTools(active: unknown): Array<{ name: string }> };
    for (const type of ["knowledgeWork", "executor", "computerUse", null]) {
      const names = runtime.customTools(workerTurn(type)).map((tool) => tool.name);
      expect(names, String(type)).not.toContain("Skill");
      expect(names, String(type)).toContain("Read");
    }
  });

  test("graphical workers receive compact box-scoped Shell and Read guidance", () => {
    const descriptions = toolDescriptions("computerUse");
    expect(descriptions.Shell).toContain("wait for a background command with AwaitShell rather than `sleep`");
    expect(descriptions.Shell).not.toContain("committing-changes-with-git");
    expect(descriptions.Shell).not.toContain("machineId");
    expect(descriptions.Read).toContain("Reads a file on the box, the same filesystem Shell acts on.");
    expect(descriptions.AwaitShell).not.toContain("machineId");
    const schemas = Object.fromEntries((runtimeTools() as any).customTools(workerTurn("computerUse")).map((tool: any) => [tool.name, tool.parameters]));
    for (const name of ["Shell", "Read", "AwaitShell"]) expect(schemas[name].properties.machineId, name).toBeUndefined();
  });

  test("normal agents target hosts with machineId on Shell and Read", () => {
    const names = toolNames(null);
    expect(names).toEqual(NATIVE_TOOL_NAMES);
    expect(names).toContain("ListMachines");
    expect(names).toContain("Shell");
    expect(names).toContain("Read");
  });

  test("normal agents discover A2A under cursor without legacy graphical Computer control", () => {
    expect(dynamicToolNames("openteam")).toEqual([]);
    expect(dynamicToolNames("cursor")).toContain("Task");
    expect(dynamicToolNames("cursor")).toContain("SendToAgent");
    expect(dynamicToolNames("cursor")).toContain("request_box_help");
    // Teammates are listed in user_info, and other conversations are read with ReadTranscript.
    for (const removed of ["ListAgents", "ListGroups", "read_sibling_thread"])
      expect(dynamicToolNames("cursor")).not.toContain(removed);
  });

  test("StopSubagent and request_box_help decode their reference arguments and route through the control plane", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const runtime = runtimeTools() as unknown as {
      callControlPlaneTool(active: unknown, callId: string, tool: string, args: unknown): Promise<{ content: []; details: Record<string, unknown> }>;
      dynamicCatalog(active: { runtimeProfile: "agent"; pluginNamespaces: [] }): Array<{
        name: string;
        tools: Array<{ name: string; decodeArguments(args: unknown): unknown; execute(active: unknown, callId: string, args: unknown): Promise<unknown> }>;
      }>;
    };
    runtime.callControlPlaneTool = async (_active, _callId, tool, args) => {
      calls.push({ tool, args });
      return { content: [], details: {} };
    };
    const catalog = runtime.dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] }).find((namespace) => namespace.name === "cursor");
    const stop = catalog!.tools.find((tool) => tool.name === "StopSubagent")!;
    expect(stop.decodeArguments({ all: true })).toEqual({ all: true });
    expect(stop.decodeArguments({ subagent_id: "sand-subagent-1" })).toEqual({ subagent_id: "sand-subagent-1" });
    for (const invalid of [{}, { all: false }, { all: true, subagent_id: "sand-subagent-1" }])
      expect(() => stop.decodeArguments(invalid), JSON.stringify(invalid)).toThrow();
    const help = catalog!.tools.find((tool) => tool.name === "request_box_help")!;
    const handoff = { instruction: "Sign in", reason: "auth", domain: "example.com", url: "https://app.example.com/login" };
    expect(help.decodeArguments(handoff)).toEqual(handoff);
    await stop.execute({}, "call-stop", { all: true });
    expect(calls).toEqual([{ tool: "StopSubagent", args: { all: true } }]);
  });

  test("DraftExternalMessage refuses HTML email bodies and sends the server an unwrapped body", () => {
    const runtime = runtimeTools() as unknown as {
      dynamicCatalog(active: { runtimeProfile: "agent"; pluginNamespaces: [] }): Array<{
        name: string;
        tools: Array<{ name: string; decodeArguments(args: unknown): unknown }>;
      }>;
    };
    const draft = runtime.dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] })
      .find((namespace) => namespace.name === "cursor")!.tools.find((tool) => tool.name === "DraftExternalMessage")!;
    const email = { platform: "email", providerIdentifier: "p", from: "me@example.com", to: ["ann@example.com"], subject: "Hi" };
    expect(draft.decodeArguments({ ...email, body: "We reviewed the contract terms with legal on Monday and they asked us to\nadd a clause about data retention before anything gets signed.\n\nBest,\nAnn" }))
      .toMatchObject({ body: "We reviewed the contract terms with legal on Monday and they asked us to add a clause about data retention before anything gets signed.\n\nBest,\nAnn" });
    expect(() => draft.decodeArguments({ ...email, body: "Hello<br>See you" })).toThrow("body is plain text, so <br> would reach the recipient as literal text. Nothing was drafted.");
  });

  test("normal agents expose the complete plugin lifecycle management surface", () => {
    expect(dynamicToolNames("cursor")).toEqual(
      expect.arrayContaining([
        "SearchPlugins",
        "GetPlugin",
        "GetMcpServerStatus",
        "InstallPlugin",
        "UninstallPlugin",
        "AddMcpServer",
        "UninstallMcpServer",
        "AuthenticateMcpServer",
        "RestartMcpServers",
        "RenameMcpAccount",
        "RemoveMcpAccount",
        "SetMcpInstructions",
      ])
    );
  });
});

describe("durable state tools", () => {
  const namespacedStateTools = ["UpdateSkill", "UpdateProfile", "UpdateAvatar", "DisconnectChannel"];
  const cursorToolNames = (runtime: any, active: Record<string, unknown>) =>
    runtime.dynamicCatalog(active).find((namespace: any) => namespace.name === "cursor").tools.map((tool: any) => tool.name);

  test("the main agent and its routine runs get every state tool; workers and read-only agents get none", async () => {
    const runtime = runtimeTools() as any;
    for (const active of [workerTurn(null), workerTurn(null, { requestSource: "automation" })]) {
      const names = runtime.customTools(active).map((tool: any) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["UpdateMemory", "UpdateRoutine"]));
      expect(names).not.toContain("update_state");
      expect(cursorToolNames(runtime, active)).toEqual(expect.arrayContaining(namespacedStateTools));
      expect(cursorToolNames(runtime, active)).not.toContain("UpdateProject");
    }
    for (const subagentType of ["executor", "knowledgeWork", "computerUse"]) {
      for (const readOnly of [false, true]) {
        const active = workerTurn(subagentType, { readOnly });
        const names = runtime.customTools(active).map((tool: any) => tool.name);
        expect(names).not.toContain("UpdateMemory");
        expect(names).not.toContain("UpdateRoutine");
        for (const name of namespacedStateTools) expect(cursorToolNames(runtime, active)).not.toContain(name);
      }
    }
    const readOnly = { ...workerTurn("executor", { readOnly: true }), runId: "run-1", pendingSteers: [] };
    for (const name of ["UpdateMemory", "UpdateRoutine"])
      await expect(runtime.executeOpenTeamTool(readOnly, "call-1", name, { action: "pause", id: "brief" })).rejects.toThrow("read-only");
    for (const toolName of namespacedStateTools)
      await expect(runtime.callDynamicTool(readOnly, "call-1", { namespace: "cursor", toolName, arguments: {} })).rejects.toThrow("read-only");
  });

  test("each state tool reaches the control plane under its own name with parsed arguments", async () => {
    const runtime = runtimeTools() as any;
    const calls: Array<{ tool: string; args: unknown }> = [];
    runtime.callControlPlaneTool = async (_active: unknown, _callId: string, tool: string, args: unknown) => {
      calls.push({ tool, args });
      return { content: [], details: {} };
    };
    const active = { ...workerTurn(null), runId: "run-1", pendingSteers: [] };
    await runtime.executeOpenTeamTool(active, "memory", "UpdateMemory", { target: "memory", action: "write", fact: " Prefers tea. ", type: "profile" });
    await runtime.executeOpenTeamTool(active, "routine", "UpdateRoutine", { action: "pause", id: "brief" });
    await expect(runtime.executeOpenTeamTool(active, "invalid", "UpdateMemory", { action: "create", fact: "x", type: "profile" })).rejects.toThrow(
      "UpdateMemory only writes or forgets memory"
    );
    const cursor = runtime.dynamicCatalog(active).find((namespace: any) => namespace.name === "cursor");
    const namespaced: Array<[string, Record<string, unknown>]> = [
      ["UpdateSkill", { action: "delete", id: "standup" }],
      ["UpdateProfile", { title: "Designer", hidden_from_sidebar: true }],
      ["UpdateAvatar", { action: "clear" }],
      ["DisconnectChannel", { platform: "slack" }],
    ];
    for (const [name, args] of namespaced) {
      const tool = cursor.tools.find((candidate: any) => candidate.name === name);
      await tool.execute(active, name, tool.decodeArguments({ ...args, target: "skill" }));
    }
    expect(() => cursor.tools.find((tool: any) => tool.name === "UpdateProfile").decodeArguments({ avatar_shape: "triangle" })).toThrow();
    expect(calls).toEqual([
      { tool: "UpdateMemory", args: { action: "write", fact: "Prefers tea.", type: "profile" } },
      { tool: "UpdateRoutine", args: { action: "pause", id: "brief" } },
      ...namespaced.map(([tool, args]) => ({ tool, args })),
    ]);
  });
});

describe("local computer routing", () => {
  test("routes Shell by machineId while keeping omitted machineId in the box", async () => {
    const calls: string[] = [];
    const runtime = runtimeTools() as unknown as {
      processSecrets: () => Promise<Record<string, string>>;
      nativeToolExecutor: {
        shell: (...args: unknown[]) => Promise<unknown>;
        externalShell: (...args: unknown[]) => Promise<unknown>;
      };
      executeOpenTeamTool(
        active: Record<string, unknown>,
        callId: string,
        tool: string,
        args: unknown,
        signal?: AbortSignal
      ): Promise<unknown>;
    };
    runtime.processSecrets = async () => ({});
    runtime.nativeToolExecutor.shell = async () => {
      calls.push("box");
      return { content: [{ type: "text", text: "box" }], details: {} };
    };
    runtime.nativeToolExecutor.externalShell = async () => {
      calls.push("host");
      return { content: [{ type: "text", text: "host" }], details: {} };
    };
    const active = {
      subagentType: null,
      cwd: "/workspace",
      runId: "run-1",
      turnId: "run-1",
      queue: { push: () => undefined },
    };

    await runtime.executeOpenTeamTool(active, "box-call", "Shell", { command: "pwd" });
    await runtime.executeOpenTeamTool(active, "host-call", "Shell", {
      command: "pwd",
      machineId: "machine-1",
    });
    expect(calls).toEqual(["box", "host"]);
  });
});

describe("compaction durable state capture", () => {
  test("refreshes the summary todo snapshot after a successful TodoWrite", async () => {
    const runtime = runtimeTools() as unknown as {
      callControlPlaneTool(): Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
      executeTodoWrite(
        active: { todoUpdate: string | null },
        callId: string,
        args: unknown
      ): Promise<unknown>;
    };
    runtime.callControlPlaneTool = async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            todos: [
              { id: "audit", content: "Review parity", status: "completed" },
              { id: "ship", content: "Run checks", status: "in_progress" },
            ],
          }),
        },
      ],
      details: {},
    });
    const active = { todoUpdate: "- [pending] stale: Old snapshot" };
    await runtime.executeTodoWrite(active, "call-1", { todos: [] });
    expect(active.todoUpdate).toBe(
      "- **COMPLETED**: Review parity (id: audit)\n- **IN_PROGRESS**: Run checks (id: ship)"
    );
  });

  test("clears the summary todo snapshot when TodoWrite clears the queue", async () => {
    const runtime = runtimeTools() as unknown as {
      callControlPlaneTool(): Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
      executeTodoWrite(
        active: { todoUpdate: string | null },
        callId: string,
        args: unknown
      ): Promise<unknown>;
    };
    runtime.callControlPlaneTool = async () => ({
      content: [{ type: "text", text: JSON.stringify({ todos: [] }) }],
      details: {},
    });
    const active = { todoUpdate: "- [pending] stale: Old snapshot" };
    await runtime.executeTodoWrite(active, "call-1", { todos: [] });
    expect(active.todoUpdate).toBeNull();
  });
});

describe("context turn reservation", () => {
  test("reserves a context before asynchronous setup and releases it on failure", async () => {
    const runtime = new ComputerRuntime() as unknown as {
      authenticated: boolean;
      modelRuntime: {
        checkAuth(providerId: string): Promise<{ type: string; source: string }>;
        isUsingSubscription(providerId: string): boolean;
      };
      resolveModel(): object;
      start(): Promise<void>;
      contextState(contextSessionId: string): Promise<never>;
      run(request: ReturnType<typeof turnRequest>): Promise<AsyncIterable<unknown>>;
      diagnostics: { activeTurns: number };
    };
    runtime.start = async () => {};
    Object.assign((runtime as any).tools.userForms, { beginTurn: async () => {}, endTurn: async () => {} });
    runtime.authenticated = true;
    runtime.resolveModel = () => ({});
    runtime.modelRuntime = {
      checkAuth: async () => ({ type: "oauth", source: "test" }),
      isUsingSubscription: () => true,
    };
    let rejectSetup!: (error: Error) => void;
    let enteredSetup!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredSetup = resolve;
    });
    runtime.contextState = async () =>
      new Promise<never>((_resolve, reject) => {
        rejectSetup = reject;
        enteredSetup();
      });
    const contextSessionId = crypto.randomUUID();
    const first = runtime.run(turnRequest({ contextSessionId }));
    await entered;
    await expect(
      runtime.run(turnRequest({ contextSessionId, runId: crypto.randomUUID() }))
    ).rejects.toThrow("already has an active Pi turn");
    rejectSetup(new Error("setup failed"));
    await expect(first).rejects.toThrow("setup failed");
    expect(runtime.diagnostics.activeTurns).toBe(0);
  });

  test("rejects an out-of-root persisted session before opening it", async () => {
    const runtime = new ComputerRuntime() as unknown as {
      authenticated: boolean;
      modelRuntime: {
        checkAuth(providerId: string): Promise<{ type: string; source: string }>;
        isUsingSubscription(providerId: string): boolean;
      };
      resolveModel(): object;
      start(): Promise<void>;
      run(request: ReturnType<typeof turnRequest>): Promise<AsyncIterable<unknown>>;
      diagnostics: { activeTurns: number };
    };
    runtime.start = async () => {};
    Object.assign((runtime as any).tools.userForms, { beginTurn: async () => {}, endTurn: async () => {} });
    runtime.authenticated = true;
    runtime.resolveModel = () => ({});
    runtime.modelRuntime = {
      checkAuth: async () => ({ type: "oauth", source: "test" }),
      isUsingSubscription: () => true,
    };
    await expect(
      runtime.run(turnRequest({ sessionPath: "/tmp/not-an-openteam-session.jsonl" }))
    ).rejects.toThrow("outside the OpenTeam session directory");
    expect(runtime.diagnostics.activeTurns).toBe(0);
  });

  test("replays a staged archive from the matching persisted Pi compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-compaction-recovery-"));
    temporaryRoots.push(root);
    const sessionsDir = join(root, "sessions", "openteam");
    const contextSessionsDir = join(root, "context-sessions");
    await Promise.all([
      mkdir(sessionsDir, { recursive: true }),
      mkdir(contextSessionsDir, { recursive: true }),
    ]);
    const contextSessionId = crypto.randomUUID();
    const compactionId = crypto.randomUUID();
    const store = new BotCompactionArchiveStore(contextSessionsDir);
    await store.stage(contextSessionId, {
      id: compactionId,
      reason: "approaching_token_limit",
      summary: "recoverable summary",
      prefixDigest: "a".repeat(64),
      userInfoMessage: null,
      lastUserMessage: {
        role: "user",
        content: [{ type: "text", text: "latest request" }],
        timestamp: 1,
      },
      preservedTailMessages: [],
      summarizedMessages: [],
      tokensBefore: 95_000,
      tokensAfter: 2_000,
      imageCount: 0,
      turnCount: 12,
      usage: null,
      startedAt: new Date(1).toISOString(),
      completedAt: new Date(2).toISOString(),
    });

    const manager = SessionManager.create(root, sessionsDir, { id: contextSessionId });
    const firstKeptEntryId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "latest request" }],
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    manager.appendCompaction(
      "recoverable summary",
      firstKeptEntryId,
      95_000,
      { openteamBotCompaction: true, id: compactionId },
      true
    );

    const runtime = new ComputerRuntime() as unknown as {
      sessionsDir: string;
      contextSessionsDir: string;
      compactionArchive: BotCompactionArchiveStore;
      compaction: BotCompactionCoordinator;
      contextState(contextSessionId: string): Promise<{ epoch: number }>;
    };
    runtime.sessionsDir = sessionsDir;
    runtime.contextSessionsDir = contextSessionsDir;
    runtime.compactionArchive = store;
    runtime.compaction = new BotCompactionCoordinator(store, 0);

    expect((await runtime.contextState(contextSessionId)).epoch).toBe(1);
    expect((await store.latest(contextSessionId))?.piBaseMessageCount).toBe(
      manager.buildSessionContext().messages.length
    );
    expect(await store.stagedId(contextSessionId)).toBeNull();
  });
});

test('foreground Task yields existing worker identity for pending steering instead of polling forever', async () => {
  const runtime = runtimeTools() as any;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url:any, init:any) => { calls++; const body=JSON.parse(init.body); return Response.json(body.foregroundYield ? {foregroundYielded:true,subagent_id:'existing-worker',status:'running',message:'MessageSubagent'} : {foregroundPending:true,subagent_id:'existing-worker',attempt_id:'attempt'}); }) as unknown as typeof fetch;
  try {
    const result = await runtime.callControlPlaneTool({pendingSteers:[{content:'Apply correction'}]}, 'call', 'Task', {});
    expect(calls).toBe(2);
    expect(result.content[0].text).toContain('existing-worker');
    expect(result.content[0].text).toContain('MessageSubagent');
  } finally {globalThis.fetch=previousFetch;}
});

test('foreground Task keeps the same call identity while waiting without steering', async () => {
  const runtime = runtimeTools() as any;
  const previousFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = (async (_url:any, init:any) => {
    requests.push(JSON.parse(init.body));
    return Response.json(requests.length === 1 ? {foregroundPending:true,subagent_id:'existing-worker'} : {status:'completed',result:'done'});
  }) as unknown as typeof fetch;
  try {
    const result = await runtime.callControlPlaneTool({pendingSteers:[]}, 'same-call', 'Task', {prompt:'existing task'});
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(result.content[0].text).toContain('done');
  } finally {globalThis.fetch=previousFetch;}
});

test('browser workers retain their parent desktop session and steering cancels only the waiting run', async () => {
  const tools = runtimeTools() as any;
  tools.screens.browserEndpointForAgent = async () => 'http://unused-test-endpoint';
  const used: string[] = [];
  const makeBrowser = (name: string) => ({connected:true, configureUploads(){}, registerPrivateValues(){},
    async execute(tool: string, _args: unknown, signal?: AbortSignal) {
      used.push(name);
      if (tool === 'browser_wait_for') await new Promise((_,reject) => {signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});});
      return {content:[],details:{}};
    }});
  const first=makeBrowser('first'), other=makeBrowser('other');
  tools.browserUseSessions.set('old-worker',first); tools.browserSessionScreens.set('old-worker','desktop-a');
  tools.browserUseSessions.set('other-worker',other); tools.browserSessionScreens.set('other-worker','desktop-b');
  const turn={botId:'new-worker',screenBotId:'desktop-a',cwd:'/workspace',runId:'wait-run',requestSource:'automation'};
  await tools.callBrowserUse(turn,'browser_console_messages',{all:true});
  expect(tools.browserUseSessions.get('new-worker')).toBe(first);
  await tools.callBrowserUse({...turn,botId:'another-worker',screenBotId:'desktop-b'},'browser_console_messages',{});
  expect(tools.browserUseSessions.get('another-worker')).toBe(other);
  const pending=tools.callBrowserForTurn(turn,'browser_wait_for',{time:10});
  await new Promise(resolve=>setTimeout(resolve,0));
  tools.interruptShellWaits('different-run'); expect(tools.shellWaits.size).toBe(1);
  tools.interruptShellWaits('wait-run'); await expect(pending).rejects.toThrow('new user message');
  expect(tools.shellWaits.size).toBe(0); expect(used).toEqual(['first','other','first']);
});

test('Task reads subagent_type spellings as their type and reports a refused dispatch as Error: reason', async () => {
  const runtime = runtimeTools() as any;
  const previousFetch = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body).arguments);
    return Response.json({ error: { code: 'subagent_not_resumable', message: "That background subagent is still running, so it can't be resumed yet." } }, { status: 409 });
  }) as unknown as typeof fetch;
  try {
    const task = runtime.dynamicCatalog(workerTurn(null)).find((namespace: any) => namespace.name === 'cursor').tools.find((tool: any) => tool.name === 'Task');
    expect(task.decodeArguments({ description: 'Book', prompt: 'Book it', subagent_type: 'computer_use' }).subagent_type).toBe('computerUse');
    const active = { ...workerTurn(null), runId: 'run-1', discoveredDynamicTools: new Set(['cursor/Task']), pendingSteers: [] };
    await expect(runtime.executeOpenTeamTool(active, 'call', 'CallDynamicTool', {
      namespace: 'cursor', toolName: 'Task', arguments: { description: 'Book', prompt: 'Book it', subagent_type: 'computer_use' },
    })).rejects.toThrow(/^Error: That background subagent is still running, so it can't be resumed yet\.$/);
    expect(sent[0].subagent_type).toBe('computerUse');
  } finally { globalThis.fetch = previousFetch; }
});

test('Computer rewrites other tools\' action names before its schema check', () => {
  const runtime = runtimeTools() as any;
  const computer = runtime.customTools(workerTurn('computerUse')).find((tool: any) => tool.name === 'Computer');
  expect(computer.prepareArguments({ action: 'left_click', x: 3, y: 4 })).toEqual({ action: 'click', button: 'left', x: 3, y: 4 });
  expect(() => computer.prepareArguments({ action: 'right_click', button: 'left' })).toThrow(
    'Invalid arguments:\naction: Computer has no right_click action, and it would mean button "right", not "left". Send action "click" with the button you mean.'
  );
});

test('the parent-only dispatch reminder names only tools the parent has and that child type lacks', async () => {
  const { parentOnlyToolsFor } = await import('@openteam/contracts/subagent-dispatch');
  const runtime = runtimeTools() as any;
  // A worker without CallDynamicTool cannot reach the catalog.
  const surface = (active: Record<string, unknown>) => {
    const direct: string[] = runtime.customTools(active).map((tool: any) => tool.name);
    return new Set<string>([
      ...direct,
      ...(direct.includes('CallDynamicTool') ? runtime.dynamicCatalog(active).flatMap((namespace: any) => namespace.tools.map((tool: any) => tool.name)) : []),
    ]);
  };
  const parent = new Set([...surface(workerTurn(null)), ...surface(workerTurn(null, { requestSource: 'automation' }))]);
  for (const type of ['executor', 'knowledgeWork', 'computerUse', 'videoReview', 'watchVideo', undefined]) {
    const child = type ? surface(workerTurn(type)) : new Set<string>();
    const listed = [...parentOnlyToolsFor(type).keys()];
    expect(listed.length, String(type)).toBeGreaterThan(5);
    for (const tool of listed) {
      expect(parent.has(tool), `${type}: parent lacks ${tool}`).toBe(true);
      expect(child.has(tool), `${type}: child has ${tool}`).toBe(false);
    }
  }
  for (const type of ['executor', 'knowledgeWork', 'computerUse', 'videoReview', 'watchVideo'])
    for (const tool of parentOnlyToolsFor(undefined).keys())
      expect(surface(workerTurn(type)).has(tool), `${type} has resumable ${tool}`).toBe(false);
});

test('a readonly worker lists and greps with Shell on the box, reads only through read tools, and moves no files', async () => {
  const runtime = runtimeTools() as any;
  const readonly = workerTurn('executor', { readOnly: true, runId: 'run-ro', discoveredDynamicTools: new Set(), pendingSteers: [],
    pluginNamespaces: [{ name: 'gmail_work', description: 'Gmail', namespaceStatus: 'ready', tools: [
      { connectionId: 'c1', name: 'search_threads', description: '', inputSchema: { type: 'object' }, source: 'gmail/gmail' },
      { connectionId: 'c1', name: 'whoami', description: '', inputSchema: { type: 'object' }, source: 'custom/custom', readOnly: true },
      { connectionId: 'c1', name: 'send_message', description: '', inputSchema: { type: 'object' }, source: 'gmail/gmail' },
    ] }] });
  expect(runtime.customTools(readonly).map((tool: any) => tool.name)).toEqual(['Shell', 'Read', 'GetDynamicTools', 'CallDynamicTool', 'AwaitShell', 'WebSearch', 'WebFetch']);
  expect(runtime.dynamicCatalog(readonly).find((namespace: any) => namespace.name === 'cursor').tools.map((tool: any) => tool.name)).toEqual([]);
  await expect(runtime.executeOpenTeamTool(readonly, 'call-1', 'Shell', { command: 'ls', machineId: 'mac' })).rejects.toThrow("Read-only agents cannot access the user's computer");
  const calls: string[] = [];
  runtime.callControlPlaneTool = async (_active: unknown, _callId: string, _tool: string, args: any) => {
    calls.push(args.toolName);
    return { content: [{ type: 'text', text: 'ok' }], details: {} };
  };
  for (const toolName of ['search_threads', 'whoami']) {
    readonly.discoveredDynamicTools.add(`gmail_work/${toolName}`);
    await runtime.callDynamicTool(readonly, `call-${toolName}`, { namespace: 'gmail_work', toolName, arguments: {} });
  }
  expect(calls).toEqual(['search_threads', 'whoami']);
  await expect(runtime.callDynamicTool(readonly, 'call-send', { namespace: 'gmail_work', toolName: 'send_message', arguments: {} }))
    .rejects.toThrow('This tool is unavailable to a read-only plugin agent');
});
