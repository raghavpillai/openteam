import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BROWSER_INLINE_BYTES = 32 * 1024;
const PREVIEW_BYTES = 8 * 1024;

/** Call only after redaction; saved observations have the same visibility as screenshots. */
export async function saveLargeBrowserOutput(
  result: AgentToolResult<Record<string, unknown>>,
  directory: string
): Promise<AgentToolResult<Record<string, unknown>>> {
  const content = await Promise.all(result.content.map(async part => {
    if (part.type !== "text" || Buffer.byteLength(part.text, "utf8") <= BROWSER_INLINE_BYTES)
      return part;
    const bytes = Buffer.from(part.text, "utf8");
    const path = join(directory, `browser-output-${randomUUID()}.txt`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path, bytes, { flag: "wx", mode: 0o644 });
    } catch {
      // The browser action already happened. Keep its observation rather than
      // reporting failure and encouraging the agent to replay the action.
      return part;
    }
    // Avoid splitting a UTF-8 code point. The file always retains every byte.
    let end = PREVIEW_BYTES;
    while ((bytes[end]! & 0xc0) === 0x80) end--;
    const preview = bytes.subarray(0, end).toString("utf8");
    return { ...part, text: `Large browser output saved to: ${path} (${bytes.length} bytes).\nUse Read with offset/limit or Shell text search to inspect the complete observation. Element refs belong to this snapshot and may become stale after another browser action.\n\nPreview:\n${preview}\n… preview truncated; complete output is in the file above.` };
  }));
  return { ...result, content };
}
