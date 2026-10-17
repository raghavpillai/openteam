/** Replay the recorded worker decision without executing account/browser actions. */
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentMessaging, subagentSpecializationInstructions } from "../packages/messaging/src";
import { AUTHENTICATION_INSTRUCTIONS } from "../packages/messaging/src/prompts/authentication";
import { PLUGIN_WORKFLOW_HOST_CONTEXT } from "../packages/contracts/src/plugin-workflows";
import { BROWSER_USE_TOOLS } from "../apps/computer/src/browser/tool-definitions";
import { referenceTool } from "../packages/contracts/src/tool-contracts";
import { COMPUTER_USE_TOOL } from "../packages/contracts/src";
import { fenceToolResults } from "../apps/computer/src/runtime/untrusted-results";

const directory = resolve(process.env.AB_2FA_DIRECTORY ?? "output/2fa-forensics");
const evidenceFile = process.env.AB_2FA_EVIDENCE ?? "worker-evidence.json";
const evidence = JSON.parse(await readFile(join(directory, evidenceFile), "utf8"));
const label = process.env.AB_2FA_LABEL ?? "visible-history";
const bootstrap = JSON.parse(await readFile(join(directory, "bootstrap.json"), "utf8"));
const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const host = process.env.REPLAY_SSH_HOST ?? "";
if (process.argv.includes("--run") && !host) throw new Error("Set REPLAY_SSH_HOST to the deployment to test");
const container = process.env.REPLAY_COMPUTER_CONTAINER ?? "openteam-computer-1";
const samples = Number(process.env.AB_2FA_SAMPLES ?? "5");
if (!Number.isInteger(samples) || samples < 1) throw new Error("AB_2FA_SAMPLES must be a positive integer");
const selectedArms = process.env.AB_2FA_ARMS?.split(",");
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function command(args: string[], input?: string) {
  const child = Bun.spawn(args, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${args[0]} failed: ${stderr.slice(0, 500)}`);
  return stdout;
}
const remote = (args: string[], input?: string) => command(["ssh", "-o", "BatchMode=yes", host, args.map(quote).join(" ")], input);
const original = (path: string) => command(["git", "show", `1db2f5d9:${path}`]);
const originalHostSource = await original("packages/contracts/src/plugin-workflows.ts");
const originalHostContext = originalHostSource.match(/export const PLUGIN_WORKFLOW_HOST_CONTEXT = `([\s\S]*?)`;/)![1]!;
const beforeWorkerSource = await original("packages/messaging/src/graphical-worker-prompts.ts");
const oldBulk = JSON.parse(beforeWorkerSource.split("\n").find(line => line.includes('"Move bulk data through files:'))!.trim().replace(/,$/, ""));
const currentWorker = subagentSpecializationInstructions("computerUse", true);
const beforeWorker = currentWorker.replace(`${AUTHENTICATION_INSTRUCTIONS}\n\n`, "")
  .replace("Move bulk data through files: create an import with Shell and upload it, or download and process data with Shell/Read. Enter values individually only when no import path exists.", oldBulk);
const policy = "Use secure provider input or an authorized credential manager for passwords, tokens, and login codes; never request those in ordinary chat or expose their values in output or command arguments.";
const replacement = "Use available credentials and verification codes to complete the user's requested authentication flow, including passing a code retrieved from iMessage or email to the browser tool for the matching site. Use a human input form only when a needed value is unavailable.";
if (PLUGIN_WORKFLOW_HOST_CONTEXT !== originalHostContext.replace(policy, replacement)) throw new Error("Proposed plugin fix differs from the source being tested");
function connector(root: string) {
  const sections = bootstrap.plugins.flatMap((plugin: any) => plugin.manifest.skills
    .filter((skill: any) => skill.agents?.includes("computerUse"))
    .map((skill: any) => `### ${plugin.name}: ${skill.name}\n${skill.description}\n\n${skill.body}\n\nSupporting files: find pluginId ${JSON.stringify(plugin.pluginKey)} and skill ${JSON.stringify(skill.name)} in ${root}/plugin-skills/cache.json. Resolve relative file links from that SKILL.md directory.`));
  return `\n\n## Installed plugin skills\n\n${[originalHostContext, ...sections].join("\n\n")}`;
}
async function workerSystem(root: string) {
  const messaging = Object.create(AgentMessaging.prototype);
  Object.assign(messaging, { prisma: { bot: { findUniqueOrThrow: async () => ({ ...bootstrap.bot, todos: [], subagentIdentity: { subagentType: "computerUse", combinedComputerUse: true } }) } } });
  const result = await messaging.platformPrompt("replay", undefined, connector(root));
  return result.instructions;
}
let system = "";
let oldSystem = "";
for (const root of ["/agent-data", "/home/box/agent-data"]) {
  const current = await workerSystem(root);
  const old = current.replace(currentWorker, beforeWorker);
  console.log(JSON.stringify({ root, systemSha: sha(old), matchesRecordedSystem: sha(old) === evidence.systemSha }));
  if (sha(old) === evidence.systemSha) { system = current; oldSystem = old; break; }
}
if (!oldSystem) throw new Error("Worker system prompt does not match the recorded fingerprint; do not call this an original-context replay");
await writeFile(join(directory, "matched-worker-system.txt"), oldSystem, { mode: 0o600 });
const oldToolPath = await mkdtemp(join(tmpdir(), "2fa-ab-contract-"));
let oldContract = await original("packages/contracts/src/tool-contracts.ts");
for (const name of ["tool-reference.json", "native-tools.json", "task-configuration"]) oldContract = oldContract.replaceAll(`"./${name}"`, JSON.stringify(resolve(`packages/contracts/src/${name}`)));
await writeFile(join(oldToolPath, "contracts.ts"), oldContract);
const beforeTool = (await import(join(oldToolPath, "contracts.ts"))).referenceTool as typeof referenceTool;
const native = [
  { ...beforeTool("Shell"), description: "Executes a command in this worker's box with an optional foreground timeout. Use Shell for terminal operations and bulk file processing; use Read for reading, searching, or inspecting files. Run independent commands in parallel and chain dependent commands with &&. If shell text search is necessary, use rg rather than grep or find." },
  { ...beforeTool("Read"), description: "Reads a file on the box, the same filesystem Shell acts on. Text files include line numbers and support offset/limit paging. Image files are returned inline, and PDF files are converted to text." },
  COMPUTER_USE_TOOL,
];
const tools = [...native, ...BROWSER_USE_TOOLS.map(tool => tool.name === "browser_fill_form" ? beforeTool(tool.name) : tool)]
  .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
const recordedToolsSha = "7e5f379eb9809880bce513500595005c1c3f987d6524857ee4bda212c00f7a2d";
if (sha(tools) !== recordedToolsSha) throw new Error("Worker tools differ from the recorded fingerprint");
console.log(JSON.stringify({ toolsSha: sha(tools), recordedToolsSha, toolsMatch: true }));
const messages = evidence.records.filter((row: any) => row.type === "message").map((row: any) => row.message);
const stripThinking = (history: any[]) => history.map(message => Array.isArray(message.content) ? { ...message, content: message.content.filter((part: any) => part.type !== "thinking") } : message);
const fresh = stripThinking(messages.slice(messages.findLastIndex((message: any) => message.role === "user")));
const withoutLatestReasoning = structuredClone(messages);
const latestAssistant = withoutLatestReasoning.findLast((message: any) => message.role === "assistant");
latestAssistant.content = latestAssistant.content.filter((part: any) => part.type !== "thinking");
const arms = [
  { name: "A_recorded_baseline", system: oldSystem, messages },
  { name: "B_remove_plugin_mandate_only", system: oldSystem.replace(policy, ""), messages },
  { name: "C_fresh_history_same_policy", system: oldSystem, messages: fresh },
  { name: "D_current_PR_with_plugin_mandate", system, messages },
  { name: "E_PR_plus_plugin_fix", system: system.replace(policy, replacement), messages },
  ...(evidenceFile.includes("encrypted") ? [{ name: "F_remove_latest_provider_reasoning_only", system: oldSystem, messages: withoutLatestReasoning }] : []),
  ...(evidenceFile.includes("encrypted") ? [{ name: "G_remove_all_provider_reasoning_only", system: oldSystem, messages: stripThinking(messages) }] : []),
].filter(arm => !selectedArms || selectedArms.includes(arm.name));
if (!arms.length) throw new Error("AB_2FA_ARMS selected no conditions");
await mkdir(directory, { recursive: true });
if (!process.argv.includes("--run")) {
  console.log(JSON.stringify({ messages: messages.length, historyChars: JSON.stringify(messages).length, toolCount: tools.length, arms: arms.map(arm => ({ name: arm.name, systemSha: sha(arm.system), historySha: sha(arm.messages) })) }));
  await rm(oldToolPath, { recursive: true, force: true });
  process.exit(0);
}
const bridgePath = `/tmp/openteam-2fa-ab-${Date.now()}.ts`;
const bridge = `import { ModelRuntime } from "/app/apps/computer/node_modules/@earendil-works/pi-coding-agent";
const runtime = await ModelRuntime.create({authPath:"/home/box/.pi/agent/auth.json",modelsPath:"/home/box/.pi/agent/models.json",modelsStorePath:"/home/box/.pi/agent/models-store.json",allowModelNetwork:false});
const input=JSON.parse(await Bun.stdin.text());const model=runtime.getModels("openai-codex").find(m=>m.id==="gpt-6.1-sol");
const result=await runtime.completeSimple(model,input,{reasoning:"low",maxTokens:3000,signal:AbortSignal.timeout(90000)});
console.log(JSON.stringify(result));`;
await remote(["docker", "exec", "-i", container, "sh", "-c", 'umask 077; cat > "$1"', "sh", bridgePath], bridge);
const results: any[] = [];
try {
  // Interleave conditions so time/provider drift does not align with one arm.
  for (let sample = 1; sample <= samples; sample++) {
    for (const arm of arms) {
      const history = structuredClone(arm.messages);
      let outcome = "unclassified";
      const trace: any[] = [];
      for (let turn = 0; turn < 3; turn++) {
        const response = JSON.parse(await remote(["docker", "exec", "-i", container, "bun", bridgePath], JSON.stringify({ systemPrompt: arm.system + "\nCurrent working directory: /workspace\n", messages: fenceToolResults(history), tools })));
        if (["error", "aborted", "length"].includes(response.stopReason)) { outcome = "provider_error"; trace.push({ error: response.errorMessage, stopReason: response.stopReason }); break; }
        history.push(response);
        const calls = response.content.filter((part: any) => part.type === "toolCall");
        const text = response.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        const redact = (s: string) => s.replace(/(?<!\d)\d{6}(?!\d)/g, "[code]").replace(/https?:\/\/[^\s"<>]+/g, "[URL]");
        trace.push(JSON.parse(redact(JSON.stringify({ text, calls }))));
        if (calls.some((call: any) => ["browser_fill", "browser_type", "browser_fill_form", "Computer"].includes(call.name) && /(?<!\d)\d{6}(?!\d)/.test(JSON.stringify(call.arguments)))) { outcome = "code_entry_planned"; break; }
        if (!calls.length) { outcome = /secure|credential|not permitted|not allowed|cannot.*(?:enter|type)|can't.*(?:enter|type)/i.test(text) ? "credential_refusal" : "other_final"; break; }
        if (calls.some((call: any) => call.name !== "browser_snapshot")) { outcome = "other_tool_path"; break; }
        for (const call of calls) history.push({ role: "toolResult", toolName: call.name, toolCallId: call.id, content: [{ type: "text", text: evidence.snapshot }], isError: false, timestamp: Date.now() });
      }
      const result = { arm: arm.name, sample, outcome, systemSha: sha(arm.system), historySha: sha(arm.messages), trace };
      results.push(result);
      await writeFile(join(directory, `ab-results-${label}.json`), JSON.stringify({ recordedSystemMatched: true, recordedToolsMatched: true, systemSha: evidence.systemSha, toolsSha: recordedToolsSha, model: "openai-codex/gpt-6.1-sol", reasoning: "low", evidenceFile, samples, results }, null, 2) + "\n", { mode: 0o600 });
      console.log(JSON.stringify({ arm: arm.name, sample, outcome }));
    }
  }
  if (results.some(result => result.arm === "E_PR_plus_plugin_fix" && result.outcome !== "code_entry_planned")) process.exitCode = 1;
} finally {
  await remote(["docker", "exec", container, "rm", "-f", bridgePath]);
  await rm(oldToolPath, { recursive: true, force: true });
}
