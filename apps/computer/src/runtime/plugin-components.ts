import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PluginHook, PluginHookEvent, PluginRuntimePackage } from "@openteam/plugin-sdk";
import { agentProcessIdentity, sanitizedAgentEnvironment } from "../agent-process";
import type { ActiveTurn } from "./types";

type ObjectValue = Record<string, any>;
type InferHook = (
  prompt: string,
  model: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<string>;
type ApproveHook = (callId: string, reason: string, input: ObjectValue) => Promise<boolean>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const textParts = (content: any) =>
  Array.isArray(content)
    ? content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    : "";

export async function runPluginCommand(
  command: string,
  cwd: string,
  input: ObjectValue,
  signal: AbortSignal,
  timeout: number
): Promise<{ code: number; output: string }> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      ...agentProcessIdentity(),
      env: sanitizedAgentEnvironment(process.env, {
        CURSOR_PLUGIN_ROOT: cwd,
        CURSOR_PROJECT_DIR: input.cwd,
        OPENTEAM_PLUGIN_ROOT: cwd,
      }),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    const terminate = () => {
      stopped = true;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(terminate, timeout);
    signal.addEventListener("abort", terminate, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) terminate();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", terminate);
      if (signal.aborted) reject(signal.reason);
      else if (stopped) reject(new Error("Plugin hook exceeded its time or output limit"));
      else resolveResult({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const globMatches = (glob: string, value: string) =>
  new Bun.Glob(glob).match(value) || new Bun.Glob(glob).match(value.replace(/^\.\//, ""));

export function expandPluginAgent(
  packages: readonly PluginRuntimePackage[],
  input: ObjectValue
): ObjectValue {
  if (input.plugin_agent === undefined) return input;
  if (input.resume)
    throw new Error("A resumed agent already has a fixed template; omit plugin_agent");
  const [key, name] = String(input.plugin_agent).split(":");
  const agent = packages.find((pkg) => pkg.key === key)?.agents.find((item) => item.name === name);
  if (!agent) throw new Error("Unknown or disabled plugin agent");
  const { plugin_agent, ...args } = input;
  return {
    ...args,
    prompt: `${agent.body}\n\nTask from the parent:\n${String(input.prompt ?? "")}`,
    ...(agent.model && input.model === undefined ? { model: agent.model } : {}),
    ...(agent.readonly ? { read_only: true, subagent_type: "executor" } : {}),
    ...(input.run_in_background === undefined
      ? { run_in_background: agent.background ?? false }
      : {}),
  };
}

export function pluginComponentsExtension(
  active: ActiveTurn,
  infer: InferHook,
  approve: ApproveHook
): { name: string; hidden: boolean; factory: ExtensionFactory } {
  const packages = active.pluginRuntimePackages ?? [];
  const signal = active.pluginAbortController?.signal ?? new AbortController().signal;
  const rules = new Set<string>();
  let started = false;
  let loops = 0;
  return {
    name: "openteam-plugin-components",
    hidden: true,
    factory(pi) {
      const inject = (source: string, text: string) =>
        pi.sendMessage({
          customType: "plugin-context",
          content: `Plugin ${source}:\n${text}`,
          display: false,
        });
      const run = async (event: PluginHookEvent, data: ObjectValue, blocking = false) => {
        const context: string[] = [];
        for (const pkg of packages)
          for (const hook of pkg.hooks.filter((item) => item.event === event)) {
            if (active.readOnly && hook.command) continue;
            if (
              hook.matcher &&
              !new RegExp(hook.matcher).test(
                String(data.command ?? data.tool_name ?? data.file_path ?? "")
              )
            )
              continue;
            const input = {
              conversation_id: active.contextSessionId,
              generation_id: active.runId,
              workspace_roots: [active.cwd],
              cwd: active.cwd,
              hook_event_name: event,
              cursor_version: "openteam",
              ...data,
            };
            let output: ObjectValue;
            try {
              if (hook.prompt) {
                const encoded = JSON.stringify(input);
                const prompt = hook.prompt.includes("$ARGUMENTS")
                  ? hook.prompt.replaceAll("$ARGUMENTS", encoded)
                  : `${hook.prompt}\n${encoded}`;
                output = object(
                  JSON.parse(await infer(prompt, hook.model, hook.timeout * 1000, signal))
                );
              } else {
                const root = await realpath(pkg.installPath);
                const allowed = await realpath(
                  resolve(process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data", "plugins/cache")
                );
                if (!root.startsWith(allowed + sep))
                  throw new Error("Plugin hook is outside the installed package cache");
                const response = await runPluginCommand(
                  hook.command!,
                  root,
                  input,
                  signal,
                  hook.timeout * 1000
                );
                output =
                  response.code === 2
                    ? { permission: "deny", reason: "Plugin hook blocked the action" }
                    : response.code === 0 && response.output.trim()
                      ? object(JSON.parse(response.output))
                      : {};
              }
            } catch (error) {
              if (signal.aborted) throw error;
              inject(pkg.key, `${event} hook failed; no hook decision was applied.`);
              continue;
            }
            const reason = String(
              output.user_message ??
                output.reason ??
                output.agent_message ??
                `Plugin ${pkg.key} blocked this action`
            ).slice(0, 8000);
            if (
              blocking &&
              (output.permission === "deny" ||
                output.decision === "deny" ||
                output.continue === false ||
                output.ok === false)
            )
              return { block: true, reason, context };
            if (
              blocking &&
              output.permission === "ask" &&
              !(await approve(String(data.tool_call_id ?? `plugin:${event}`), reason, input))
            )
              return {
                block: true,
                reason: "The user declined the plugin review. Do not retry.",
                context,
              };
            if (typeof output.additional_context === "string")
              context.push(output.additional_context.slice(0, 32_000));
            if (typeof output.agent_message === "string")
              context.push(output.agent_message.slice(0, 32_000));
            if (blocking && output.updated_input && typeof output.updated_input === "object")
              Object.assign(data.tool_input ?? {}, output.updated_input);
            if (
              event === "stop" &&
              typeof output.followup_message === "string" &&
              !active.endTurnRequested &&
              loops < (hook.loopLimit ?? 5)
            ) {
              loops++;
              pi.sendUserMessage(output.followup_message.slice(0, 32_000), {
                deliverAs: "followUp",
              });
            }
          }
        return { block: false, context };
      };
      pi.on("input", async (event) => {
        const result = await run("beforeSubmitPrompt", { prompt: event.text }, true);
        if (result.block) throw new Error(result.reason);
        for (const pkg of packages)
          for (const command of pkg.commands) {
            const prefix = `/${pkg.key}:${command.name}`;
            if (event.text === prefix || event.text.startsWith(prefix + " ")) {
              const args = event.text.slice(prefix.length).trim();
              return {
                action: "transform",
                text: command.body.includes("$ARGUMENTS")
                  ? command.body.replaceAll("$ARGUMENTS", args)
                  : `${command.body}\n\n${args}`,
                images: event.images,
              };
            }
          }
      });
      pi.on("before_agent_start", async (event) => {
        const context: string[] = [];
        if (!started) {
          started = true;
          const result = await run("sessionStart", {}, true);
          if (result.block) throw new Error(result.reason);
          context.push(...result.context);
        }
        for (const pkg of packages) {
          for (const rule of pkg.rules) {
            const id = `${pkg.key}:${rule.name}`;
            if (rule.alwaysApply || event.prompt.includes(`@${id}`)) {
              context.push(`${id}\n${rule.body}`);
              rules.add(id);
            } else
              context.push(
                `Rule @${id}: ${rule.description}${rule.globs.length ? `; applies to ${rule.globs.join(", ")}` : " (mention to apply)"}`
              );
          }
          for (const agent of pkg.agents)
            context.push(
              `Task plugin_agent=${JSON.stringify(`${pkg.key}:${agent.name}`)}: ${agent.description}${agent.readonly ? " (readonly)" : ""}`
            );
          for (const command of pkg.commands)
            context.push(`User command /${pkg.key}:${command.name}: ${command.description}`);
        }
        return context.length
          ? {
              message: {
                customType: "plugin-context",
                content: context.join("\n\n"),
                display: false,
              },
            }
          : undefined;
      });
      pi.on("tool_call", async (event) => {
        const input = event.input as ObjectValue;
        if (event.toolName === "Task" && input.plugin_agent !== undefined) {
          const expanded = expandPluginAgent(packages, input);
          for (const key of Object.keys(input)) delete input[key];
          Object.assign(input, expanded);
        }
        const data = {
          tool_name:
            event.toolName === "CallDynamicTool"
              ? `${input.namespace}.${input.toolName}`
              : event.toolName,
          tool_call_id: event.toolCallId,
          tool_input: input,
          ...input,
        };
        for (const pkg of packages)
          for (const rule of pkg.rules) {
            const path = input.path ?? input.file_path;
            const id = `${pkg.key}:${rule.name}`;
            if (
              typeof path === "string" &&
              !rules.has(id) &&
              rule.globs.some((glob) =>
                globMatches(glob, relative(active.cwd, resolve(active.cwd, path)))
              )
            ) {
              rules.add(id);
              inject(id, rule.body);
            }
          }
        const events: PluginHookEvent[] = [
          "preToolUse",
          ...(event.toolName === "Shell"
            ? ["beforeShellExecution" as const]
            : event.toolName === "Read"
              ? ["beforeReadFile" as const]
              : event.toolName === "CallDynamicTool"
                ? ["beforeMCPExecution" as const]
                : event.toolName === "Task"
                  ? ["subagentStart" as const]
                  : []),
        ];
        for (const name of events) {
          const result = await run(name, data, true);
          if (result.block) return { block: true, reason: result.reason };
          for (const text of result.context) inject(name, text);
        }
      });
      pi.on("tool_result", async (event) => {
        const data = {
          tool_name: event.toolName,
          tool_call_id: event.toolCallId,
          tool_input: event.input,
          tool_output: textParts(event.content),
          ...event.input,
        };
        const events: PluginHookEvent[] = [
          event.isError ? "postToolUseFailure" : "postToolUse",
          ...(event.toolName === "Shell"
            ? ["afterShellExecution" as const]
            : event.toolName === "CallDynamicTool"
              ? ["afterMCPExecution" as const]
              : event.toolName === "Task" && event.input.run_in_background === false
                ? ["subagentStop" as const]
                : ["Edit", "Write"].includes(event.toolName)
                  ? ["afterFileEdit" as const]
                  : []),
        ];
        for (const name of events) {
          const result = await run(name, data);
          for (const text of result.context) inject(name, text);
        }
      });
      pi.on("message_end", async (event) => {
        if (event.message.role !== "assistant") return;
        await run("afterAgentResponse", { text: textParts(event.message.content) });
        const thought = event.message.content
          .filter((part) => part.type === "thinking")
          .map((part) => part.thinking)
          .join("\n");
        if (thought) await run("afterAgentThought", { text: thought });
      });
      pi.on("session_before_compact", async () => {
        await run("preCompact", {});
      });
      pi.on("agent_end", async () => {
        await run("stop", {
          status: active.endTurnRequested ? "completed" : "finished",
          loop_count: loops,
        });
      });
      let closed = false;
      active.closePluginSession = async () => {
        if (closed || !started || signal.aborted) return;
        closed = true;
        await run("sessionEnd", {});
      };
      pi.on("session_shutdown", async () => {
        await active.closePluginSession?.();
      });
    },
  };
}
