import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { ResultStore } from "./results";

export type Args = Record<string, any>;
export type Tool = {
  name: string;
  description: string;
  inputSchema: {
    [key: string]: any;
    type: "object";
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  run: (args: Args) => Promise<unknown>;
};
export const string = (description: string, extra = {}) => ({
  type: "string",
  description,
  ...extra,
});
export const strings = (description: string) => ({
  type: "array",
  description,
  items: { type: "string" },
  maxItems: 100,
});
export const integer = (description: string, maximum = 100, minimum = 1) => ({
  type: "integer",
  description,
  minimum,
  maximum,
});
export const page = {
  pageToken: string("Opaque nextPageToken from the previous result"),
  maxResults: integer("Maximum results on this page", 100),
};
export const segment = (value: unknown) => {
  if (typeof value !== "string" || !value || value === "." || value === ".." || value.length > 2048)
    throw new Error("A valid resource ID is required");
  return encodeURIComponent(value);
};
export const tool = (
  name: string,
  description: string,
  properties: Record<string, any>,
  required: string[],
  run: Tool["run"],
  risk: "read" | "write" | "destructive" = "read"
): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: risk === "read", destructiveHint: risk === "destructive" },
  run,
});

export class GoogleApi {
  constructor(
    private readonly base: string,
    private readonly token = process.env.GOOGLE_ACCESS_TOKEN,
    private readonly fetcher: (input: string | URL, init?: RequestInit) => Promise<Response> = fetch
  ) {}
  at(base: string) {
    if (!/^https:\/\/[a-z0-9.-]*googleapis\.com(?:\/|$)/.test(base))
      throw new Error("Invalid Google API destination");
    return new GoogleApi(base, this.token, this.fetcher);
  }
  async request(
    path: string,
    query: Args = {},
    method = "GET",
    body?: unknown,
    options: {
      rawBody?: string | Uint8Array;
      contentType?: string;
      binary?: boolean;
      maxBytes?: number;
      headers?: Record<string, string>;
      includeHeaders?: boolean;
    } = {}
  ) {
    if (!this.token) throw new Error("Google account is not authorized. Connect it in Plugins.");
    const url = new URL(`${this.base}${path}`);
    if (url.origin !== new URL(this.base).origin) throw new Error("Invalid Google API destination");
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, String(item));
    }
    const response = await this.fetcher(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined || options.rawBody !== undefined
          ? { "Content-Type": options.contentType ?? "application/json" }
          : {}),
        ...options.headers,
      },
      body: options.rawBody instanceof Uint8Array ? new Uint8Array(options.rawBody).buffer : options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const limit = options.maxBytes ?? 64 * 1024 * 1024;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error(
            `Google response exceeds ${limit} bytes. Narrow the query or open the file in Google Drive.`
          );
        }
        chunks.push(next.value);
      }
    }
    const buffer = Buffer.concat(chunks);
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        message = JSON.parse(buffer.toString()).error?.message ?? message;
      } catch {}
      const help =
        response.status === 401
          ? " Authorize the account again in Plugins."
          : response.status === 403
            ? " Check the API is enabled, granted scopes, and this account's access to the resource."
            : "";
      throw new Error(
        `Google API ${response.status}: ${String(message).replaceAll(this.token, "[redacted]")}${help}`
      );
    }
    if (options.binary)
      return {
        data: buffer.toString("base64"),
        mimeType: response.headers.get("content-type") ?? "application/octet-stream",
        size,
      };
    if (options.includeHeaders) return { headers: Object.fromEntries(response.headers), status: response.status, body: buffer.length ? JSON.parse(buffer.toString()) : null };
    if (!buffer.length) return { success: true };
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("json")
      ? JSON.parse(buffer.toString())
      : { text: buffer.toString("utf8"), mimeType: contentType };
  }
}

export async function servePlugin(name: string, tools: Tool[]) {
  const store = new ResultStore(name);
  tools = [...tools, store.tool()];
  const server = new Server({ name, version: "1.2.0" }, { capabilities: { tools: {} } });
  const entries = new Map(
    tools.map((entry) => [
      entry.name,
      { entry, validate: createToolValidator(entry.inputSchema) },
    ])
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ run, ...definition }) => definition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const match = entries.get(request.params.name);
      if (!match) throw new Error("Unknown tool");
      const args = request.params.arguments ?? {};
      const result = match.validate(args);
      if (!result.valid) throw new Error(`Invalid tool arguments: ${result.errorMessage}`);
      const value = await match.entry.run(args);
      return { content: [{ type: "text", text: JSON.stringify(request.params.name === "read_result" ? value : await store.capture(value)) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google tool failed";
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: process.env.GOOGLE_ACCESS_TOKEN
              ? message.replaceAll(process.env.GOOGLE_ACCESS_TOKEN, "[redacted]")
              : message,
          },
        ],
      };
    }
  });
  // A 64 MB binary upload becomes ~86 MB of base64; the SDK default is only 10 MB.
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 * 1024 }));
}
