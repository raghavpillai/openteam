export const textFromContent = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("");
};

export const thinkingFromContent = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "thinking"; thinking: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "thinking" &&
        typeof (part as { thinking?: unknown }).thinking === "string"
    )
    .map((part) => part.thinking)
    .join("");
};

export const boundedText = (value: string, limit = 100_000): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n… output truncated by OpenTeam`;

export const safeToolResult = (result: unknown, isError = false): unknown => {
  if (!result || typeof result !== "object") return result;
  const record = result as {
    content?: unknown;
    details?: unknown;
    isError?: unknown;
  };
  const content = Array.isArray(record.content)
    ? record.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const item = part as Record<string, unknown>;
        if (item.type === "image") {
          return {
            type: "image",
            mimeType: item.mimeType ?? "image/png",
            omitted: true,
          };
        }
        return item.type === "text" && typeof item.text === "string"
          ? { type: "text", text: boundedText(item.text) }
          : item;
      })
    : [];
  return {
    content,
    details: record.details ?? null,
    isError: isError || Boolean(record.isError),
  };
};

export const toolItem = (
  id: string,
  toolName: string,
  args: unknown,
  status: "inProgress" | "completed" | "failed",
  result?: unknown
): Record<string, unknown> => {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (["bash", "Shell", "ExternalShell"].includes(toolName)) {
    const toolResult =
      result && typeof result === "object" ? (result as Record<string, unknown>) : null;
    const details =
      toolResult?.details && typeof toolResult.details === "object"
        ? (toolResult.details as Record<string, unknown>)
        : null;
    return {
      type: "commandExecution",
      id,
      command: typeof record.command === "string" ? record.command : "Shell command",
      shellKind: details?.status === "running" ? "background" : "foreground",
      status,
      result,
    };
  }
  if (toolName === "edit" || toolName === "write") {
    return {
      type: "fileChange",
      id,
      tool: toolName,
      path: typeof record.path === "string" ? record.path : null,
      status,
      result,
    };
  }
  return {
    type: "dynamicToolCall",
    id,
    tool: toolName,
    arguments: args,
    status,
    result,
  };
};
