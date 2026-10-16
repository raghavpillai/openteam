/** Opt-in live-model comparison. Uses synthetic messages and a disposable browser.
 * Provider credentials stay inside the existing computer container.
 * Run: OPENTEAM_BROWSER_TEST_EXECUTABLE="/path/to/chrome" bun scripts/replay-2fa-prompts.ts
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { referenceTool } from "../packages/contracts/src/tool-contracts";
import { renderPlatformBaseSystemPrompt, PLATFORM_BASE_SYSTEM_PROMPT } from "../packages/messaging/src/platform-system-prompt";
import { MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS, subagentSpecializationInstructions } from "../packages/messaging/src";
import { AUTHENTICATION_INSTRUCTIONS } from "../packages/messaging/src/prompts/authentication";
import managed from "../packages/messaging/src/prompts/managed-skills.json";
import { BrowserUseSession } from "../apps/computer/src/browser/use";
import { outOfProcessPlaywright } from "../apps/computer/src/browser/playwright-driver";

const executablePath = process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE;
if (!executablePath) throw new Error("Set OPENTEAM_BROWSER_TEST_EXECUTABLE to a Chromium executable");
const container = process.env.REPLAY_COMPUTER_CONTAINER ?? "openteam-computer-1";
const base = process.env.REPLAY_BASE_REF ?? "5aa47b26^";
const output = resolve(process.env.REPLAY_OUTPUT ?? "output/2fa-prompt-replay");
const scenarios = process.env.REPLAY_SCENARIO ? [process.env.REPLAY_SCENARIO] : ["fresh", "stuck-conversation"];
const historyFormat = process.env.REPLAY_HISTORY_FORMAT ?? "tool-delivery";
if (!["tool-delivery", "text"].includes(historyFormat)) throw new Error("REPLAY_HISTORY_FORMAT must be tool-delivery or text");
const root = await mkdtemp(join(tmpdir(), "2fa-prompt-replay-"));
const bridgePath = `/tmp/openteam-2fa-replay-${Date.now()}.ts`;
const code = "482917"; // Synthetic, never a real account code.
const timestamp = () => Date.now();
async function command(cmd: string[], input?: string) {
  const process = Bun.spawn(cmd, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (status) throw new Error(`${cmd[0]} failed (${status}): ${stderr.slice(0, 1000)}`);
  return stdout;
}
const old = (path: string) => command(["git", "show", `${base}:${path}`]);
const oldPlatform = JSON.parse(await old("packages/messaging/src/prompts/grok-platform.json"));
const oldManaged = JSON.parse(await old("packages/messaging/src/prompts/managed-skills.json"));
let oldContracts = await old("packages/contracts/src/tool-contracts.ts");
for (const name of ["tool-reference.json", "native-tools.json", "task-configuration"]) {
  oldContracts = oldContracts.replaceAll(`"./${name}"`, JSON.stringify(resolve(`packages/contracts/src/${name}`)));
}
const oldContractsPath = join(root, "old-tool-contracts.ts");
await writeFile(oldContractsPath, oldContracts);
const beforeTool = (await import(oldContractsPath)).referenceTool as typeof referenceTool;
const oldWorkerSource = await old("packages/messaging/src/graphical-worker-prompts.ts");
const oldBulkLine = oldWorkerSource.split("\n").find(line => line.includes('"Move bulk data through files:'))!;
const oldBulk = JSON.parse(oldBulkLine.trim().replace(/,$/, ""));
const beforeWorker = subagentSpecializationInstructions("computerUse")
  .replace(`${AUTHENTICATION_INSTRUCTIONS}\n\n`, "")
  .replace("Move bulk data through files: create an import with Shell and upload it, or download and process data with Shell/Read. Enter values individually only when no import path exists.", oldBulk);
const afterMain = renderPlatformBaseSystemPrompt({ managedSkills: true });
const beforeMain = afterMain
  .replace(PLATFORM_BASE_SYSTEM_PROMPT, oldPlatform.sections.map((section: any) => section.text).join("\n\n"))
  .replace("request_user_form is available for structured input the user needs to supply.", "Use request_user_form for structured browser input.");
const bridge = `import { ModelRuntime } from "/app/apps/computer/node_modules/@earendil-works/pi-coding-agent";
const runtime = await ModelRuntime.create({ authPath: "/home/box/.pi/agent/auth.json", modelsPath: "/home/box/.pi/agent/models.json", modelsStorePath: "/home/box/.pi/agent/models-store.json", allowModelNetwork: false });
const selection = (await Bun.file("/home/box/agent-data/settings.json").json()).inference;
const input = JSON.parse(await Bun.stdin.text());
const model = runtime.getModels(selection.providerId).find(model => model.id === selection.modelId);
if (!model) throw new Error("Configured model not found");
const response = await runtime.completeSimple(model, input, { reasoning: selection.reasoning === "off" ? undefined : selection.reasoning, maxTokens: 5000, signal: AbortSignal.timeout(90000) });
console.log(JSON.stringify({ selection, response }));`;
await command(["docker", "exec", "-i", container, "sh", "-c", 'umask 077; cat > "$1"', "sh", bridgePath], bridge);
const toolsFor = (tool: typeof referenceTool, names: string[]) => names.map(name => {
  const contract = tool(name);
  return { name, description: contract.description, parameters: contract.inputSchema };
});
const messageTool = { name: "ChatItems", description: "Read recent iMessage messages, including service verification messages.", parameters: { type: "object", properties: {}, additionalProperties: false } };
const text = (result: any) => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
const user = (content: string) => ({ role: "user", content, timestamp: timestamp() });
const assistant = (content: any[]) => ({ role: "assistant", content, api: "openai-completions", provider: "openrouter", model: "x-ai/grok-4.7", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: timestamp() });
const delivered = (content: string, id: string) => historyFormat === "text" ? [assistant([{ type: "text", text: content }])] : [
  { ...assistant([{ type: "toolCall", id, name: "SendToUser", arguments: { type: "text", content, end_turn: true } }]), stopReason: "toolUse" },
  { role: "toolResult", toolCallId: id, toolName: "SendToUser", content: [{ type: "text", text: "Message delivered." }], isError: false, timestamp: timestamp() },
];
const source = `Latest iMessage from DocuSign: Your verification code is ${code}. Requested just now for this document.`;
let selection: unknown;
async function complete(systemPrompt: string, messages: any[], tools: any[]) {
  const raw = await command(["docker", "exec", "-i", container, "bun", bridgePath], JSON.stringify({ systemPrompt, messages, tools }));
  const result = JSON.parse(raw);
  selection = result.selection;
  if (["error", "aborted", "length"].includes(result.response.stopReason)) throw new Error(`Model stopped: ${result.response.stopReason}: ${result.response.errorMessage ?? ""}`);
  return result.response;
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html><h1>DocuSign verification fixture</h1><form>${Array.from({length: 6}, (_, i) => `<input aria-label="Code ${i + 1}" maxlength="1" inputmode="numeric">`).join("")}<button>Verify</button></form><script>
for(const input of document.querySelectorAll("input")) input.addEventListener("input",()=>{if(input.value.length===1)input.nextElementSibling?.focus()});
document.querySelector("form").addEventListener("submit",event=>{event.preventDefault();if(Array.from(document.querySelectorAll("input")).map(input=>input.value).join("") === "${code}") document.body.innerHTML="<h1>Document ready</h1><p>Synthetic agreement: the monthly service fee is $25. No signature is requested.</p>"});
</script>`, { headers: { "content-type": "text/html" } }) });
const driver = await outOfProcessPlaywright();
const browser = await driver.playwright.chromium.launch({ headless: true, executablePath });
const results: any[] = [];
try {
  for (const scenario of scenarios) {
    for (const variant of ["before", "after"] as const) {
      console.log(`RUN ${scenario} / ${variant}`);
      const context = await browser.newContext();
      const session = new (BrowserUseSession as any)(browser, context, join(root, `${scenario}-${variant}`)) as BrowserUseSession;
      const snapshot = text(await session.execute("browser_navigate", { url: server.url.origin }));
      const contract = variant === "before" ? beforeTool : referenceTool;
      const trace: any[] = [];
      let humanInputRequested = false;
      const mainPrompt = [variant === "before" ? beforeMain : afterMain, MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS,
        "## Loaded in-chat-forms skill", (variant === "before" ? oldManaged : managed).skills.find((skill: any) => skill.id === "in-chat-forms").content,
        `## Current task state\nThe requested document is open at ${server.url.origin}. The browser worker reported this page:\n${snapshot}\nThe cursor namespace provides request_user_form and request_box_help. The connected iMessage namespace provides ChatItems.`,
      ].join("\n\n");
      const messages: any[] = [user("Read and summarize the Capital One document in DocuSign. Find the verification code in iMessage and enter it to open the document.")];
      if (scenario === "stuck-conversation") messages.push(
        { ...assistant([{ type: "toolCall", id: "prior-imessage", name: "ChatItems", arguments: {} }]), stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "prior-imessage", toolName: "ChatItems", content: [{ type: "text", text: source }], isError: false, timestamp: timestamp() },
        ...delivered("I found the DocuSign code in iMessage already. The blocker is entering it: I don’t have a secure autofill route from iMessage to DocuSign. Please enter it in the secure form above; I won’t ask you to paste it into chat.", "prior-refusal-1"),
        user("Just do it idrc"),
        ...delivered("I understand. This isn’t waiting on your permission; the secure code-entry step needs your input. Enter it in the form above, and I can continue reading the document. Sorry I kept implying I could finish that step myself.", "prior-refusal-2"),
        user("Just enter it from imessage"),
      );
      async function loop(actor: "main" | "worker", prompt: string, history: any[], tools: any[], limit: number): Promise<string> {
        let final = "";
        for (let turn = 0; turn < limit; turn++) {
          const response = await complete(prompt, history, tools);
          history.push(response);
          const calls = response.content.filter((part: any) => part.type === "toolCall");
          for (const part of response.content.filter((part: any) => part.type === "text")) trace.push({ actor, text: part.text });
          if (!calls.length) return response.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
          for (const call of calls) {
            trace.push({ actor, tool: call.name, arguments: call.arguments });
            let result: string;
            let end = false;
            if (call.name === "ChatItems" || (call.name === "CallDynamicTool" && call.arguments.toolName === "ChatItems")) result = source;
            else if (call.name === "SendToUser") { final = call.arguments.content ?? ""; result = "Message delivered."; end = call.arguments.end_turn === true; }
            else if (call.name === "GetDynamicTools") {
              result = JSON.stringify(call.arguments.toolName === "ChatItems" ? messageTool : [contract("request_user_form"), contract("request_box_help")]);
            } else if (call.name === "CallDynamicTool") {
              humanInputRequested = true; result = "Waiting for the user to enter the requested value or take over the screen."; end = true;
            } else if (call.name === "Task" && actor === "main") {
              const workerPrompt = variant === "before" ? beforeWorker : subagentSpecializationInstructions("computerUse");
              result = await loop("worker", workerPrompt, [user(call.arguments.prompt)], toolsFor(contract, ["browser_snapshot", "browser_fill", "browser_type", "browser_click", "browser_press_key"]), 8);
            } else if (actor === "worker" && call.name.startsWith("browser_")) {
              try { result = text(await session.execute(call.name, call.arguments)); }
              catch (error) { result = `Tool failed: ${error instanceof Error ? error.message : "unknown error"}`; }
            } else throw new Error(`Unexpected tool ${call.name}`);
            trace.push({ actor, result: result.slice(0, 6000) });
            history.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: result }], isError: false, timestamp: timestamp() });
            if (end) return final || result;
          }
        }
        return final || "Reached replay turn limit";
      }
      const final = await loop("main", mainPrompt, messages, [...toolsFor(contract, ["SendToUser", "Task", "GetDynamicTools", "CallDynamicTool"]), messageTool], 10);
      const page = await (session as any).ensurePage();
      const verified = await page.getByRole("heading", { name: "Document ready", exact: true }).count() === 1;
      const result = { scenario, variant, historyFormat, promptSha256: createHash("sha256").update(mainPrompt).digest("hex"), verified, humanInputRequested, final, trace };
      results.push(result);
      await mkdir(output, { recursive: true });
      await writeFile(join(output, `${scenario}-${variant}.json`), JSON.stringify(result, null, 2) + "\n");
      console.log(JSON.stringify({ scenario, variant, verified, humanInputRequested, final }));
      await context.close();
    }
  }
  const report = { base, head: (await command(["git", "rev-parse", "HEAD"])).trim(), selection, limitations: ["Synthetic message and verification-page fixtures; no real DocuSign envelope or iMessage account was used.", "Main-agent Task calls synchronously run a graphical worker in this harness; deployment scheduling is not replayed.", "One sample per scenario and variant; the original screenshot model and complete hidden context are unknown."], results };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${join(output, "report.json")}`);
  if (results.some(result => result.variant === "after" && !result.verified)) process.exitCode = 1;
} finally {
  await browser.close(); await driver.stop(); server.stop(true);
  await command(["docker", "exec", container, "rm", "-f", bridgePath]);
  await rm(root, { recursive: true, force: true });
}
