import type { PluginDefinition } from "./types";

export type PluginTemplateMode = "skills" | "remote-mcp" | "packaged-mcp" | "hybrid";
const connectorSource = `import { createInterface } from "node:readline";
// A dependency-free MCP example. Keep diagnostic output on stderr.
const tool = { name: "greet", description: "Return a greeting from this package.",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  annotations: { readOnlyHint: true } };
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!("id" in request)) continue;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "packaged-example", version: "1.0.0" } };
  else if (request.method === "tools/list") result = { tools: [tool] };
  else if (request.method === "tools/call" && request.params.name === "greet") result = {
    content: [{ type: "text", text: (process.env.PLUGIN_GREETING || "Hello") + ", " + String(request.params.arguments?.name || "there") + "!" }] };
  else if (request.method === "ping") result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } }) + "\\n"); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`;

export function createPluginTemplate(mode: PluginTemplateMode, key: string): PluginDefinition {
  const local = mode === "packaged-mcp" || mode === "hybrid";
  const skills = mode === "skills" || mode === "hybrid";
  return {
    schemaVersion: 1,
    key,
    name: "My Plugin",
    version: "1.0.0",
    publisher: "Your name",
    description: "Describe what this plugin helps people do.",
    category: "Productivity",
    featured: false,
    components: [
      ...(skills ? ["skills" as const] : []),
      ...(mode !== "skills" ? ["mcp" as const] : []),
    ],
    skills: skills
      ? [
          {
            name: "my-skill",
            description: "When to use this skill.",
            body: "Write the instructions here.",
            path: "skills/my-skill",
          },
        ]
      : [],
    connections:
      mode === "skills"
        ? []
        : [
            {
              key: "tools",
              name: "My tools",
              transport: local ? "stdio" : "http",
              auth: "none",
              endpoint: local ? "" : "https://example.com/mcp",
              tools: [],
              ...(local
                ? {
                    configuration: {
                      command: "bun",
                      args: ["${PLUGIN_ROOT}/connector/server.mjs"],
                      cwd: "${PLUGIN_ROOT}",
                      env: { PLUGIN_GREETING: "${GREETING}" },
                    },
                  }
                : {}),
            },
          ],
    ...(local
      ? {
          setupFields: [
            {
              key: "GREETING",
              label: "Greeting",
              type: "string" as const,
              required: false,
              secret: false,
              default: "Hello",
            },
          ],
          files: {
            "connector/server.mjs": connectorSource,
            "README.md":
              '# Packaged MCP example\n\nInstall from Develop, set a greeting, then Save and connect. Run greet with {"name":"World"} in the tool tester. The connector uses the Bun runtime already installed on your Bot computer.\n\nKeep provider dependencies inside connector/. Export a built standalone entry point and its assets when your connector needs external libraries. No provider dependency belongs in the app server or UI.\n',
          },
        }
      : {}),
  };
}
