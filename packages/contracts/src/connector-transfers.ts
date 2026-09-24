import { parseReferenceArguments } from "./reference-parsers";
import { referenceTool } from "./tool-contracts";
export const CONNECTOR_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
export const CONNECTOR_TRANSFER_TOOLS = ["upload_file", "download_file"].map(referenceTool);
export function parseConnectorTransfer(tool: string, raw: unknown): Record<string, any> {
  const input = parseReferenceArguments(tool, raw);
  if (tool === "upload_file" && input.destination.overwrite !== undefined)
    throw new Error("File uploads do not support destination.overwrite");
  if (tool === "download_file" && !input.source.fileId)
    throw new Error("File downloads require source.fileId");
  return input;
}
