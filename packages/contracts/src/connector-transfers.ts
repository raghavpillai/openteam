import { parseReferenceArguments } from "./reference-parsers";
import { referenceTool } from "./tool-contracts";
export const CONNECTOR_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
const string = { type: "string", minLength: 1 };
export const CONNECTOR_TRANSFER_TOOLS = [
  {
    name: "upload_file",
    description:
      "Upload a box file directly to an enabled Google Drive, OneDrive or Gmail account. Bytes stay out of context. Drive creates a new file; OneDrive refuses conflicts unless overwrite=true; Gmail requires destination.draftId and attaches without sending. Drive/OneDrive folder paths must already exist. Limit 64 MiB, Gmail draft 25 MiB. connection is a discovered connection name, namespace or ID; ambiguous accounts must be selected explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        connection: string,
        sourcePath: string,
        destination: {
          type: "object",
          properties: {
            path: string,
            folderId: string,
            draftId: string,
            name: string,
            overwrite: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["connection", "sourcePath"],
      additionalProperties: false,
    },
  },
  {
    name: "download_file",
    description:
      "Download from an enabled Google Drive, OneDrive or Gmail account directly into the box. Drive native Docs/Sheets/Slides/Drawings export as docx/xlsx/pptx/png. OneDrive accepts a file ID or root-relative path. Gmail fileId is messageId/attachmentId. Destination is an absolute box path; omitted uses downloads/provider filename. Limit 64 MiB. Bytes never enter context.",
    inputSchema: {
      type: "object",
      properties: {
        connection: string,
        source: {
          type: "object",
          properties: { fileId: string, path: string },
          additionalProperties: false,
        },
        destination: { type: "object", properties: { path: string }, additionalProperties: false },
      },
      required: ["connection", "source"],
      additionalProperties: false,
    },
  },
].map(tool => referenceTool(tool.name));
export function parseConnectorTransfer(tool: string, raw: unknown): Record<string, any> {
 return parseReferenceArguments(tool, raw);
}
