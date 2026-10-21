import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerRuntime } from "../../src/runtime";
import { RuntimeTools } from "../../src/runtime/tools";
import {
  classifierContext,
  classifierUserMessage,
  classifyAction,
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFY_TOOL,
  parseClassification,
  trustedUserText,
} from "../../src/auto-review/classifier";
import {
  APPROVAL_EXPIRED,
  CLASSIFIER_MANUAL_REVIEW_ERROR_REASON,
  FEEDBACK_NOT_APPROVED_MESSAGE,
  FEEDBACK_PRIVACY_MODE_MESSAGE,
  PENDING_APPROVAL_REASON,
  USER_DECLINED,
} from "../../src/auto-review/texts";

const BLOCK = {
  decision: "BLOCK",
  blocked_effect: "outbound_or_binding_external_effect",
  who_sees_it: "GitHub remote origin",
  outbound_authorization: "unauthorized_destination",
  reason: "Push the release branch to GitHub. This publishes commits others can see.",
  action_description: "Push the release branch to acme/web on GitHub",
  proposed_allow_rule: 'Run "git push" commands on OpenTeam\'s computer',
};
const ALLOW = { decision: "ALLOW", blocked_effect: "none", outbound_authorization: "not_outbound", reason: "Local read.", action_description: "" };

const runtimeTools = () => (new ComputerRuntime() as any).tools;
/** Shell needs a writable agent directory for its terminal files. */
const shellTools = (root: string) => new RuntimeTools({} as any, "http://127.0.0.1:9", "fixture-control", root, root) as any;
const turn = (root: string, verdict: () => Record<string, unknown>, overrides: Record<string, unknown> = {}): any => {
  const classified: string[] = [];
  return {
    runId: "run", botId: "bot", contextSessionId: crypto.randomUUID(), cwd: root, runtimeProfile: "agent", subagentType: null,
    requestSource: "turn", pendingSteers: [], sentMessageCount: 0, queue: { push() {} }, pluginNamespaces: [], screenBotId: "bot",
    session: { messages: [{ role: "user", content: "<timestamp>Mon</timestamp>\n<user_query>\nShip the release\n</user_query>" }] },
    autoReview: { enabled: true, allowRules: [], askFirstRules: [], scopeBotId: "bot" },
    autoReviewComplete: async (request: { prompt: string }) => {
      classified.push(request.prompt);
      return { toolCalls: [{ name: "classify_auto_review_action", arguments: verdict() }] };
    },
    classified,
    ...overrides,
  };
};

/** The server's private approval tools, answered by the test. */
async function withControlPlane(respond: (tool: string, args: any) => unknown | Promise<unknown>, run: () => Promise<any>): Promise<any> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    // Shell reads its process secrets from the server before it runs.
    if (body.tool === "ReadProcessSecrets") return Response.json({ environment: {} });
    return Response.json(await respond(body.tool, body.arguments));
  }) as any;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("the classifier carries the reference policy and reads its verdict by the policy's own rules", () => {
  expect(CLASSIFIER_SYSTEM_PROMPT.startsWith("You are Cursor Sand's Auto-review security classifier.")).toBe(true);
  expect(CLASSIFIER_SYSTEM_PROMPT).toContain("Signing in with credentials already on the box is ordinary credential use");
  expect(CLASSIFIER_SYSTEM_PROMPT).toContain("When ready to decide, call classify_auto_review_action exactly once");
  expect(CLASSIFY_TOOL.name).toBe("classify_auto_review_action");
  expect(JSON.stringify(CLASSIFY_TOOL)).toContain("Run \\\"gh pr\\\" commands on OpenTeam's computer");
  expect(parseClassification(BLOCK, "err")).toEqual({
    kind: "block",
    reason: BLOCK.reason,
    blockedEffect: BLOCK.blocked_effect,
    actionDescription: BLOCK.action_description,
    proposedRule: BLOCK.proposed_allow_rule,
  });
  // BLOCK needs a prerequisite and an unauthorized destination; otherwise it is an ALLOW.
  expect(parseClassification({ ...BLOCK, blocked_effect: "none" }, "err")).toEqual({ kind: "allow" });
  expect(parseClassification({ ...BLOCK, outbound_authorization: "trusted_destination" }, "err")).toEqual({ kind: "allow" });
  // An Ask first rule match carries no proposed Allow rule.
  expect(parseClassification({ ...BLOCK, blocked_effect: "trusted_block_instruction", matched_block_instruction: "Ask before any git push" }, "err")).toEqual({
    kind: "block",
    reason: BLOCK.reason,
    actionDescription: BLOCK.action_description,
    appliedRules: [{ effect: "ask_first", text: "Ask before any git push" }],
  });
  expect(parseClassification({ decision: "MAYBE" }, "err")).toEqual({ kind: "reject", reason: "err" });
});

test("only the user's own words count as trusted instructions", () => {
  expect(trustedUserText("<system_reminder>x</system_reminder>\n<timestamp>t</timestamp>\n<user_query>\nPush it\n</user_query>")).toBe("Push it");
  expect(trustedUserText("[SAND_HIDDEN_PROMPT][A background task just completed] done")).toBeUndefined();
  expect(trustedUserText("[SAND_HIDDEN_PROMPT][SAND_TRUSTED_AUTOMATION_PROMPT][routine] \"Digest\" is due.\nWhat you saved to do each time:\nEmail me")).toContain("Email me");
  const context = classifierContext([
    { role: "user", content: "<user_query>\nfirst\n</user_query>" },
    { role: "user", content: "<user_query>\nsecond\n</user_query>" },
    { role: "assistant", content: [{ type: "text", text: "Working on it" }, { type: "toolCall", id: "c1", name: "Shell", arguments: {} }] },
    { role: "user", content: [{ type: "text", text: "<user_query>\nthird " + "x".repeat(5000) + "\n</user_query>" }] },
  ]);
  expect(context.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  expect(context[0]!.content).toBe("second");
  expect(context[2]!.content.length).toBe(4000);
  expect(context[2]!.content).toContain("...[auto-review context truncated]...");
  const prompt = classifierUserMessage(context, { action: "shell", arguments: { command: "git push", project_permissions: { auto_run: { allow_instructions: ["A"], block_instructions: [] } } } });
  expect(prompt).toContain("## Trusted user instructions\n[user]\nsecond");
  expect(prompt).toContain("## Recent Bot narration and prior actions (untrusted)\n[bot]\nWorking on it");
  expect(prompt).toContain('"command": "git push"');
  expect(prompt).toContain('"allow_instructions": [\n      "A"\n    ]');
});

test("a classifier failure or timeout is the reference's manual-review error", async () => {
  const reject = { kind: "reject" as const, reason: CLASSIFIER_MANUAL_REVIEW_ERROR_REASON };
  expect(await classifyAction({ complete: async () => { throw new Error("down"); }, messages: [], target: { action: "shell", arguments: {} }, errorReason: CLASSIFIER_MANUAL_REVIEW_ERROR_REASON })).toEqual(reject);
  expect(await classifyAction({ complete: async () => ({ toolCalls: [] }), messages: [], target: { action: "shell", arguments: {} }, errorReason: CLASSIFIER_MANUAL_REVIEW_ERROR_REASON })).toEqual(reject);
  expect(await classifyAction({
    complete: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    messages: [], target: { action: "shell", arguments: {} }, errorReason: CLASSIFIER_MANUAL_REVIEW_ERROR_REASON, timeoutMs: 20,
  })).toEqual(reject);
});

test("a blocked Shell call returns to the model; its approval retry holds on the card until the user answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-review-shell-"));
  const tools = shellTools(root);
  const file = join(root, "pushed.txt");
  const command = `printf pushed > '${file}'`;
  try {
    const active = turn(root, () => BLOCK);
    await expect(tools.executeOpenTeamTool(active, "a", "Shell", { command })).rejects.toThrow(
      `Rejected: ${BLOCK.reason}\n\n<system_reminder>\nAuto-review blocked this autonomous tool call. Decide now between two paths: (1) if a genuinely safer, lower-privilege, authorized path satisfies the request, use it; (2) if this blocked action is still necessary and the user should approve it, immediately retry the exact same Shell call with request_smart_mode_approval set to true AND smart_mode_block_reason set to the exact block reason text above.`
    );
    expect(active.classified[0]).toContain("[user]\nShip the release");
    expect(active.classified[0]).toContain(command.replaceAll("'", "'"));

    // Approve: the command runs after the card.
    const calls: Array<[string, any]> = [];
    let waits = 0;
    await withControlPlane((tool, args) => {
      calls.push([tool, args]);
      if (tool === "RequestApproval") return { status: "pending", approvalId: "card-1" };
      return ++waits < 2 ? { status: "pending", approvalId: "card-1" } : { status: "approved", approvalId: "card-1" };
    }, () => tools.executeOpenTeamTool(active, "b", "Shell", { command, block_until_ms: 5000, request_smart_mode_approval: true, smart_mode_block_reason: BLOCK.reason }));
    expect(await readFile(file, "utf8")).toBe("pushed");
    expect(calls.map(([tool]) => tool)).toEqual(["RequestApproval", "AwaitApproval", "AwaitApproval"]);
    expect(calls[0]![1]).toMatchObject({
      surface: "box_shell",
      summary: `Run a command on OpenTeam's computer from ${root}`,
      reason: BLOCK.reason,
      actionDescription: BLOCK.action_description,
      command,
      proposedRule: BLOCK.proposed_allow_rule,
      expiryPolicy: "park",
    });

    // Deny and expiry are final for that action.
    await expect(withControlPlane((tool) => (tool === "RequestApproval" ? { status: "pending", approvalId: "card-2" } : { status: "denied", approvalId: "card-2" }),
      () => tools.executeOpenTeamTool(active, "c", "Shell", { command: "echo two", request_smart_mode_approval: true, smart_mode_block_reason: BLOCK.reason }))).rejects.toThrow(`Rejected: ${USER_DECLINED}`);
    // The same denied action is blocked again without another classifier call.
    const before = active.classified.length;
    await expect(tools.executeOpenTeamTool(active, "c2", "Shell", { command: "echo two" })).rejects.toThrow(`Rejected: ${BLOCK.reason}`);
    expect(active.classified.length).toBe(before);
    await expect(withControlPlane((tool) => (tool === "RequestApproval" ? { status: "pending", approvalId: "card-3" } : { status: "expired", approvalId: "card-3", retired: "ttl" }),
      () => tools.executeOpenTeamTool(active, "d", "Shell", { command: "echo three", request_smart_mode_approval: true }))).rejects.toThrow(`Rejected: ${APPROVAL_EXPIRED}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("while a card waits, no other side effect starts; with Auto-review off nothing is classified", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-review-pending-"));
  const tools = shellTools(root);
  try {
    const active = turn(root, () => BLOCK);
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const held = withControlPlane(async (tool) => {
      if (tool === "RequestApproval") return { status: "pending", approvalId: "card" };
      if (tool === "AwaitApproval") {
        await answered;
        return { status: "denied", approvalId: "card" };
      }
      return { cancelled: true };
    }, async () => {
      const waiting = tools.executeOpenTeamTool(active, "a", "Shell", { command: "echo a", request_smart_mode_approval: true }).catch((error: Error) => error.message);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const other = turn(root, () => ALLOW, { runId: "worker-run", botId: "worker", contextSessionId: "worker" });
      other.autoReview.scopeBotId = "bot";
      const blocked = await tools.executeOpenTeamTool(other, "b", "Shell", { command: "echo b" }).catch((error: Error) => error.message);
      answer();
      return [await waiting, blocked];
    });
    expect(await held).toEqual([`Rejected: ${USER_DECLINED}`, PENDING_APPROVAL_REASON]);
    // The server refuses a second card while one waits elsewhere.
    await expect(withControlPlane(() => ({ status: "busy" }), () =>
      tools.executeOpenTeamTool(active, "c", "Shell", { command: "echo c", request_smart_mode_approval: true }))).rejects.toThrow(`Rejected: ${PENDING_APPROVAL_REASON}`);

    const off = turn(root, () => BLOCK, { autoReview: { enabled: false, allowRules: [], askFirstRules: [], scopeBotId: "bot" } });
    const result = await withControlPlane(() => ({}), () => tools.executeOpenTeamTool(off, "d", "Shell", { command: "echo ok", block_until_ms: 5000 }));
    expect(result.content[0].text).toContain("ok");
    expect(off.classified).toEqual([]);
    const schema = (active: any) => tools.customTools(active).find((tool: any) => tool.name === "Shell").parameters.properties;
    expect(Object.keys(schema(active))).toContain("request_smart_mode_approval");
    expect(Object.keys(schema(off))).not.toContain("request_smart_mode_approval");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a blocked MCP call names the CallDynamicTool retry; the retry shows the connector's card", async () => {
  const tools = runtimeTools();
  const linear = {
    name: "linear", description: "Linear", namespaceStatus: "ready",
    tools: [{ connectionId: "c", name: "create_issue", description: "Create an issue", inputSchema: { type: "object" }, source: "linear" }],
  };
  const active = turn("/tmp", () => BLOCK, { pluginNamespaces: [linear] });
  const call = { namespace: "linear", toolName: "create_issue", arguments: { title: "Ship" }, mcpDetails: { description: "Create the Ship issue in Linear" } };
  const calls: Array<[string, any]> = [];
  await expect(withControlPlane((tool, args) => { calls.push([tool, args]); return {}; }, () => tools.executeOpenTeamTool(active, "a", "CallDynamicTool", call))).rejects.toThrow(
    `Error: ${BLOCK.reason}\n\n<system_reminder>\nAuto-review blocked this autonomous MCP tool call.`
  );
  expect(calls).toEqual([]);
  expect(active.classified[0]).toContain('"tool_name": "create_issue"');
  const result = await withControlPlane((tool, args) => {
    calls.push([tool, args]);
    if (tool === "RequestApproval") return { status: "pending", approvalId: "card" };
    if (tool === "AwaitApproval") return { status: "always", approvalId: "card", savedRule: BLOCK.proposed_allow_rule };
    return { content: [{ type: "text", text: "created" }] };
  }, () => tools.executeOpenTeamTool(active, "b", "CallDynamicTool", { ...call, mcpDetails: { ...call.mcpDetails, requestSmartModeApproval: true, smartModeBlockReason: BLOCK.reason } }));
  expect(result.content[0].text).toBe("created");
  expect(calls.map(([tool]) => tool)).toEqual(["RequestApproval", "AwaitApproval", "PluginCall"]);
  expect(calls[0]![1]).toMatchObject({
    surface: "mcp",
    summary: "Create the Ship issue in Linear",
    summaryCopy: { kind: "mcp", params: { description: "Create the Ship issue in Linear", serverDisplayName: "linear", action: "send" } },
    command: 'Use linear tool create_issue with {"title":"Ship"}',
    fullRequest: 'linear create_issue\n{\n  "title": "Ship"\n}',
  });
  // "Always allow" saved the rule for the rest of the turn.
  expect(active.autoReview.allowRules).toEqual([BLOCK.proposed_allow_rule]);
});

test("a blocked routine write shows its card directly; a denial is not saved", async () => {
  const tools = runtimeTools();
  const active = turn("/tmp", () => BLOCK);
  const calls: Array<[string, any]> = [];
  const result = await withControlPlane((tool, args) => {
    calls.push([tool, args]);
    if (tool === "RequestApproval") return { status: "pending", approvalId: "card" };
    return { status: "denied", approvalId: "card" };
  }, () => tools.executeOpenTeamTool(active, "a", "UpdateRoutine", { action: "create", name: "Digest", prompt: "Email the team the summary", schedule: "0 9 * * 1-5" }));
  expect(result.content[0].text).toBe(`Not saved: ${USER_DECLINED}`);
  expect(calls.map(([tool]) => tool)).toEqual(["RequestApproval", "AwaitApproval"]);
  expect(calls[0]![1]).toMatchObject({ surface: "automation_write", fullRequest: "Email the team the summary" });
  expect(calls[0]![1].summary).toStartWith("Save the routine “Digest” to run ");
  expect(calls[0]![1].summary).toEndWith(": “Email the team the summary”");
  expect(active.classified[0]).toContain('"write_provenance": "user"');
  // Allowed writes save with no card.
  const allowed = turn("/tmp", () => ALLOW);
  const saved: string[] = [];
  await withControlPlane((tool) => { saved.push(tool); return { target: "routine", action: "pause", id: "digest" }; },
    () => tools.executeOpenTeamTool(allowed, "b", "UpdateRoutine", { action: "pause", id: "digest" }));
  expect(saved).toEqual(["UpdateRoutine"]);
  expect(allowed.classified).toEqual([]);
});

test("SendFeedback always asks on a card, even with Auto-review off, and sends only on approval", async () => {
  const tools = runtimeTools();
  const active = turn("/tmp", () => ALLOW, { feedback: "available", autoReview: { enabled: false, allowRules: [], askFirstRules: [], scopeBotId: "bot" } });
  const calls: Array<[string, any]> = [];
  const declined = await withControlPlane((tool, args) => {
    calls.push([tool, args]);
    return tool === "RequestApproval" ? { status: "pending", approvalId: "card" } : { status: "denied", approvalId: "card" };
  }, () => tools.executeOpenTeamTool(active, "a", "CallDynamicTool", { namespace: "cursor", toolName: "SendFeedback", arguments: { message: "Love the app", wantsResponse: false } }));
  expect(declined.content[0].text).toBe(FEEDBACK_NOT_APPROVED_MESSAGE);
  expect(calls.map(([tool]) => tool)).toEqual(["RequestApproval", "AwaitApproval"]);
  expect(calls[0]![1]).toMatchObject({ surface: "feedback", command: "Love the app", reason: "This exact text will be sent to the configured OpenTeam support destination from your account as product feedback. Nothing is sent unless you approve." });
  calls.length = 0;
  await withControlPlane((tool, args) => {
    calls.push([tool, args]);
    if (tool === "RequestApproval") return { status: "pending", approvalId: "card" };
    if (tool === "AwaitApproval") return { status: "approved", approvalId: "card" };
    return { feedbackStatus: "sent", wantsResponse: false, outcome: "accepted" };
  }, () => tools.executeOpenTeamTool(active, "b", "CallDynamicTool", { namespace: "cursor", toolName: "SendFeedback", arguments: { message: "Love the app", wantsResponse: false } }));
  expect(calls.map(([tool]) => tool)).toEqual(["RequestApproval", "AwaitApproval", "SendFeedback"]);
});

test("SendFeedback is offered only with a support destination, and privacy settings refuse it without a card", async () => {
  const tools = runtimeTools();
  const cursorTools = (feedback?: string) => tools.dynamicCatalog(turn("/tmp", () => ALLOW, { feedback })).find((namespace: any) => namespace.name === "cursor").tools.map((tool: any) => tool.name);
  expect(cursorTools()).not.toContain("SendFeedback");
  expect(cursorTools("privacy")).toContain("SendFeedback");
  expect(cursorTools("available")).toContain("SendFeedback");
  const calls: string[] = [];
  const refused = await withControlPlane((tool) => { calls.push(tool); return {}; },
    () => tools.executeOpenTeamTool(turn("/tmp", () => ALLOW, { feedback: "privacy" }), "a", "CallDynamicTool", { namespace: "cursor", toolName: "SendFeedback", arguments: { message: "Love the app", wantsResponse: false } }));
  expect(refused.content[0].text).toBe(FEEDBACK_PRIVACY_MODE_MESSAGE);
  expect(calls).toEqual([]);
});

test("computer and browser actions raise the card on their own; looking passes untouched", async () => {
  const { AutoReviewGate } = await import("../../src/runtime/auto-review");
  const calls: Array<[string, any]> = [];
  let answer = "approved";
  const gate = new AutoReviewGate(async (_active, _callId, tool, args) => {
    calls.push([tool, args]);
    return tool === "RequestApproval" ? { status: "pending", approvalId: "card" } : { status: answer, approvalId: "card" };
  });
  const active = turn("/tmp", () => BLOCK, { subagentType: "computerUse", runtimeProfile: "subagent", requestSource: "agent" });
  await gate.reviewComputer(active, "a", { action: "screenshot" } as any);
  await gate.reviewBrowser(active, "b", "browser_hover", { element: "Menu", target: "e1" }, "https://example.com");
  expect(active.classified).toEqual([]);
  await expect(gate.reviewComputer(active, "c", { action: "click", x: 10, y: 20 } as any)).rejects.toThrow(
    "Computer click and drag actions require a concise description field stating the intended UI target and purpose."
  );
  await expect(gate.reviewBrowser(active, "d", "browser_click", { target: "e2" }, undefined)).rejects.toThrow(
    "Browser click and drag actions require an element field: a concise description of the intended target and purpose."
  );
  await gate.reviewComputer(active, "e", { action: "click", x: 10, y: 20, description: "the Send button" } as any);
  expect(calls[0]).toEqual(["RequestApproval", expect.objectContaining({ surface: "computer", summary: "Click at (10, 20) on OpenTeam's computer to the Send button", expiryPolicy: "ttl" })]);
  expect(active.classified.at(-1)).toContain('"action_kind": "click"');
  answer = "denied";
  calls.length = 0;
  await expect(gate.reviewBrowser(active, "f", "browser_type", { element: "Message box", target: "e3", text: "Ship it", submit: true }, "https://mail.example.com/compose")).rejects.toThrow(USER_DECLINED);
  expect(calls[0]![1]).toMatchObject({ surface: "computer", summary: "Type 7 characters (“Ship it”) on https://mail.example.com/compose in OpenTeam's browser" });
  expect(active.classified.at(-1)).toContain('"target_page_url": "https://mail.example.com/compose"');
});
