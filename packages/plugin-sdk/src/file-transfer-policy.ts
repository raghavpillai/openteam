import { effectiveToolPolicy, type ToolPolicy } from "./policy";
import type { ToolDecision } from "./types";

const aliases = {
  upload_file: ["create_file", "update_draft", "upload_file"],
  download_file: ["download_file_content", "get_message", "download_file"],
};

export function fileTransferPolicy(
  policies: readonly ToolPolicy[],
  tools: readonly { name: string; defaultDecision?: ToolDecision }[],
  botId: string,
  tool: "upload_file" | "download_file"
) {
  const policy = effectiveToolPolicy(policies, tool, botId, tool === "upload_file" ? "prompt" : "allow");
  const deniedAlias = tools.some(candidate => {
    if (!aliases[tool].includes(candidate.name)) return false;
    const value = effectiveToolPolicy(policies, candidate.name, botId, candidate.defaultDecision ?? "prompt");
    return !value.enabled || value.decision === "deny";
  });
  return { ...policy, enabled: policy.enabled && policy.decision !== "deny" && !deniedAlias };
}

export function fileTransferCapabilities(
  provider: string,
  policies: readonly ToolPolicy[],
  tools: readonly { name: string; defaultDecision?: ToolDecision }[],
  botId: string
) {
  if (!["google-drive", "gmail"].includes(provider)) return undefined;
  return {
    upload: fileTransferPolicy(policies, tools, botId, "upload_file").enabled,
    download: fileTransferPolicy(policies, tools, botId, "download_file").enabled,
  };
}
