import { parseDocument } from "yaml";
import { objectValue, safePackagePath } from "./manifest";

export const PLUGIN_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeSubmitPrompt",
  "preCompact",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
] as const;
export type PluginHookEvent = (typeof PLUGIN_HOOK_EVENTS)[number];
export interface PluginHook {
  event: PluginHookEvent;
  command?: string;
  prompt?: string;
  model?: string;
  timeout: number;
  matcher?: string;
  loopLimit?: number;
}
export interface PluginRule {
  name: string;
  description: string;
  body: string;
  alwaysApply: boolean;
  globs: string[];
}
export interface PluginCommand {
  name: string;
  description: string;
  body: string;
}
export interface PluginAgent extends PluginCommand {
  model?: string;
  readonly?: boolean;
  background?: boolean;
}
export interface PluginRuntimeComponents {
  hooks: PluginHook[];
  rules: PluginRule[];
  commands: PluginCommand[];
  agents: PluginAgent[];
  warnings: string[];
}
export interface PluginRuntimePackage extends PluginRuntimeComponents {
  key: string;
  installPath: string;
}

function markdown(text: string, path: string) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const doc = front ? parseDocument(front[1]!, { prettyErrors: false }) : null;
  if (doc?.errors.length) throw new Error(`Invalid component frontmatter: ${path}`);
  const fields = objectValue(doc?.toJS({ maxAliasCount: 50 }));
  const name =
    typeof fields.name === "string"
      ? fields.name
      : path
          .split("/")
          .at(-1)!
          .replace(/\.(md|mdc)$/, "");
  if (!/^[a-zA-Z0-9][\w.-]{0,159}$/.test(name)) throw new Error(`Invalid component name: ${path}`);
  return {
    fields,
    name,
    description: typeof fields.description === "string" ? fields.description : "",
    body: front ? text.slice(front[0].length) : text,
  };
}

/** Parse only package-owned assets. No filesystem reads or code execution at import. */
export function parsePluginRuntimeComponents(
  files: Record<string, string>
): PluginRuntimeComponents {
  const result: PluginRuntimeComponents = {
    hooks: [],
    rules: [],
    commands: [],
    agents: [],
    warnings: [],
  };
  const manifest = objectValue(JSON.parse(files[".cursor-plugin/plugin.json"] ?? "{}"));
  const roots = (kind: string) => {
    const value = manifest[kind];
    return (value === undefined ? [kind] : Array.isArray(value) ? value : [value])
      .filter((v): v is string => typeof v === "string")
      .map((v) => safePackagePath(v.replace(/\/$/, "")));
  };
  for (const [path, content] of Object.entries(files)) {
    if (!/\.(md|mdc)$/.test(path)) continue;
    for (const kind of ["rules", "commands", "agents"] as const) {
      if (!roots(kind).some((root) => path === root || path.startsWith(`${root}/`))) continue;
      const { fields, ...entry } = markdown(content, path);
      if (kind === "rules") {
        const globs = Array.isArray(fields.globs)
          ? fields.globs
          : typeof fields.globs === "string"
            ? fields.globs.split(",")
            : [];
        if (globs.some((v) => typeof v !== "string" || v.length > 512))
          throw new Error(`Invalid rule globs: ${path}`);
        result.rules.push({
          ...entry,
          globs: (globs as string[]).map((v) => v.trim()),
          alwaysApply: fields.alwaysApply === true,
        });
      } else if (kind === "agents") {
        if (fields.tools || fields.disallowedTools) {
          result.warnings.push(
            `${path}: explicit tool allow/deny lists are unsupported; this agent is disabled. Use readonly: true for a restricted executor.`
          );
          continue;
        }
        result.agents.push({
          ...entry,
          model:
            typeof fields.model === "string" && fields.model !== "inherit"
              ? fields.model
              : undefined,
          readonly: fields.readonly === true,
          background: fields.background === true,
        });
      } else result.commands.push(entry);
    }
  }
  let sources: unknown[];
  if (manifest.hooks !== undefined)
    sources = Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks];
  else sources = ["hooks/hooks.json", "hooks.json"].filter((path) => files[path] !== undefined);
  for (const source of sources) {
    const value =
      typeof source === "string"
        ? JSON.parse(
            files[safePackagePath(source)] ??
              (() => {
                throw new Error(`Missing hooks file: ${source}`);
              })()
          )
        : source;
    const config = objectValue(value);
    if (config.version !== undefined && config.version !== 1)
      throw new Error("Unsupported hooks version");
    for (const [event, candidates] of Object.entries(objectValue(config.hooks ?? config))) {
      if (!PLUGIN_HOOK_EVENTS.includes(event as PluginHookEvent)) {
        result.warnings.push(`Hook ${event} is not an agent lifecycle event and will not run.`);
        continue;
      }
      if (!Array.isArray(candidates) || candidates.length > 50)
        throw new Error(`Invalid hooks: ${event}`);
      for (const candidate of candidates) {
        const hook = objectValue(candidate);
        const prompt = hook.type === "prompt" ? hook.prompt : undefined;
        const command = hook.type !== "prompt" ? hook.command : undefined;
        if (
          typeof (command ?? prompt) !== "string" ||
          !(command ?? prompt) ||
          String(command ?? prompt).length > 20_000
        )
          throw new Error(`Invalid hook command/prompt: ${event}`);
        if (hook.matcher !== undefined) {
          if (typeof hook.matcher !== "string" || hook.matcher.length > 512)
            throw new Error("Invalid hook matcher");
          new RegExp(hook.matcher);
        }
        const timeout = hook.timeout === undefined ? 30 : Number(hook.timeout);
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300)
          throw new Error("Hook timeout must be between 0 and 300 seconds");
        result.hooks.push({
          event: event as PluginHookEvent,
          command: command as string | undefined,
          prompt: prompt as string | undefined,
          model: typeof hook.model === "string" ? hook.model : undefined,
          timeout,
          matcher: hook.matcher as string | undefined,
          loopLimit:
            typeof hook.loop_limit === "number" ? Math.max(0, Math.min(5, hook.loop_limit)) : 5,
        });
      }
    }
  }
  for (const kind of ["rules", "commands", "agents"] as const)
    if (new Set(result[kind].map((item) => item.name)).size !== result[kind].length)
      throw new Error(`Duplicate plugin ${kind}`);
  return result;
}
