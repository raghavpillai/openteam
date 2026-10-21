import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Joined text above this many bytes is written to a file instead of the context, as in the reference. */
export const CONNECTOR_TEXT_FILE_THRESHOLD_BYTES = 40_000;
const CONNECTOR_TEXT_FILE_MAX_BYTES = 49 * 1024 * 1024;

export type ConnectorResultPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * A connector call reads to the model as the server's own content: text items
 * verbatim, images as images, and the server's error flag on the result.
 * `structuredContent` duplicates the text, so it is shown only when there is no content.
 */
export function connectorResultParts(body: unknown): { parts: ConnectorResultPart[]; isError: boolean } {
  const result = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  if (!result || !Array.isArray(result.content))
    return { parts: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], isError: false };
  const parts = result.content.map((item): ConnectorResultPart => {
    const part = item as Record<string, unknown> | null;
    if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")
      return { type: "image", data: part.data, mimeType: part.mimeType };
    return { type: "text", text: JSON.stringify(item) };
  });
  if (!parts.length && result.structuredContent !== undefined)
    parts.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  return { parts, isError: result.isError === true };
}

const sizeText = (bytes: number) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} bytes`);

const truncateUtf8 = (text: string, maxBytes: number) => {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, maxBytes));
  return decoded.endsWith("�") ? decoded.slice(0, -1) : decoded;
};

/**
 * Over the inline limit, the text items become one pointer to a file the agent
 * can Read selectively; images stay in place. A failed write keeps a bounded head.
 */
export async function spillConnectorText(
  parts: ConnectorResultPart[],
  cwd: string,
  write: (path: string, data: Buffer) => Promise<unknown>
): Promise<{ parts: ConnectorResultPart[]; outputPath?: string }> {
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
  if (Buffer.byteLength(text, "utf8") <= CONNECTOR_TEXT_FILE_THRESHOLD_BYTES) return { parts };
  const replaceText = (replacement: string) => {
    let placed = false;
    return parts.flatMap((part): ConnectorResultPart[] => {
      if (part.type !== "text") return [part];
      if (placed) return [];
      placed = true;
      return [{ type: "text", text: replacement }];
    });
  };
  const capped = truncateUtf8(text, CONNECTOR_TEXT_FILE_MAX_BYTES);
  const data = Buffer.from(capped, "utf8");
  const outputPath = join(cwd, "agent-tools", `${randomUUID()}.txt`);
  try {
    await write(outputPath, data);
  } catch {
    const notice = `\n\n[Output truncated: the full MCP tool output was ${Buffer.byteLength(text, "utf8")} bytes, which exceeds the inline limit of ${CONNECTOR_TEXT_FILE_THRESHOLD_BYTES} bytes, and could not be written to a file. The remainder was discarded; do not retry the same call expecting the full output.]`;
    return { parts: replaceText(truncateUtf8(text, CONNECTOR_TEXT_FILE_THRESHOLD_BYTES - Buffer.byteLength(notice, "utf8")) + notice) };
  }
  return {
    parts: replaceText(`Large output has been written to: ${outputPath} (${sizeText(data.byteLength)}, ${capped.split("\n").length} lines)`),
    outputPath,
  };
}
