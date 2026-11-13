import { describe, expect, test } from "bun:test";
import {
  connectionNamespaces,
  createPluginTemplate,
  environmentFields,
  fieldsForConnector,
  importPackage,
  parsePluginDefinition,
  scopedProcessEnvironment,
  validateMcpUrl,
  validateValues,
} from "../src";
import { emailBodyHtmlTag, unwrapHardWrappedEmailBody } from "../src/email-body";
import { createToolValidator } from "../src/json-schema";
import { parseSkillMarkdown } from "../src/skill-markdown";
// Inputs and the reference implementation's outputs for them (10-20 build).
import emailBodies from "./email-body.cases.json";

const files = {
  "plugin.json": JSON.stringify({
    name: "portable-example",
    version: "1.2.0",
    author: { name: "Example" },
    variables: {
      properties: {
        API_TOKEN: { type: "string", title: "API token" },
        LIMIT: { type: "integer", default: 2 },
      },
      required: ["API_TOKEN"],
    },
  }),
  "mcp.json": JSON.stringify({
    mcpServers: {
      remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${API_TOKEN}" } },
      local: {
        command: "example-server",
        args: ["a b", 'quoted"value'],
        env: { LIMIT: "${LIMIT}" },
      },
    },
  }),
  "skills/review/SKILL.md":
    "---\nname: review\ndescription: Review the result\n---\nRead references/style.md first.",
  "skills/review/references/style.md": "Preserve evidence.",
};

describe("portable plugin packages", () => {
  test("MCP path compatibility never allows escaping the package or absolute references", () => {
    const unsafe = (manifest: string, mcpServers: string) =>
      expect(() => importPackage({ [manifest]: JSON.stringify({ name: "unsafe", version: "1.0.0", mcpServers }), "outside.json": "{}" })).toThrow("Unsafe package path");
    for (const path of ["../../outside.json", "../nested/../../outside.json", "/tmp/config.json", "..\\config.json", "https://example.com/config.json"])
      unsafe(".cursor-plugin/plugin.json", path);
    unsafe("plugin.json", "../outside.json");
  });
  test("accepts reviewed draft sending only on packaged connectors", () => {
    const definition = importPackage(files).definition;
    const local = definition.connections.find((connection) => connection.transport === "stdio")!;
    const remote = definition.connections.find((connection) => connection.transport === "http")!;
    const withDrafts = (connection: typeof local, drafts: unknown) =>
      parsePluginDefinition({ ...definition, connections: [{ ...connection, drafts }] });
    expect(withDrafts(local, { platform: "email", tool: "send_reviewed_email" }).connections[0]!.drafts).toEqual({ platform: "email", tool: "send_reviewed_email" });
    expect(() => withDrafts(remote, { platform: "email", tool: "send" })).toThrow("Only packaged (stdio)");
    expect(() => withDrafts(local, { platform: "slack", tool: "send" })).toThrow("Unknown draft platform: slack");
    expect(() => withDrafts(local, { platform: "email" })).toThrow("draft send tool");
  });
  test("rejects traversal, private files, invalid transports, secret defaults and literal credentials", () => {
    expect(() => importPackage({ ...files, "../secret": "x" })).toThrow("Unsafe package path");
    expect(() => importPackage({ ...files, ".env": "TOKEN=x" })).toThrow("private or generated");
    const definition = importPackage(files).definition;
    const connection = definition.connections[0];
    expect(() => parsePluginDefinition({ ...definition, connections: [{ ...connection, transport: "shell" }] })).toThrow("Unsupported connector");
    expect(() => parsePluginDefinition({ ...definition, setupFields: [{ key: "TOKEN", label: "Token", secret: true, required: true, default: "secret" }] })).toThrow("Secret defaults");
    expect(() => parsePluginDefinition({ ...definition, connections: [{ ...connection, configuration: { headers: { Authorization: "Bearer real-token" } } }] })).toThrow("literal secret");
    expect(() => parsePluginDefinition({ ...definition, binaryFiles: { "../escape": "YWJj" } })).toThrow("Unsafe package path");
  });
  test("environment setup fields are unique plugin-level secrets kept from connectors", () => {
    const definition = importPackage(files).definition;
    const field = { key: "API_TOKEN", label: "Token", secret: true, required: true, environment: "SERVICE_TOKEN" };
    const parsed = parsePluginDefinition({ ...definition, setupFields: [field] });
    expect(environmentFields(parsed)).toEqual([field]);
    expect(fieldsForConnector(parsed, parsed.connections[0]!.key).map((entry) => entry.key)).not.toContain("API_TOKEN");
    for (const setupFields of [[{ ...field, key: "REGION", secret: false }], [field, { ...field, key: "OTHER_TOKEN" }], [{ ...field, environment: "1INVALID" }],
      [{ ...field, environment: "NODE_OPTIONS" }], [{ ...field, environment: "PATH" }]])
      expect(() => parsePluginDefinition({ ...definition, setupFields })).toThrow("Environment setup fields");
    const setup = { kind: "none", connectionKey: null, title: "Setup", description: "Setup", documentationUrl: null, steps: [], fields: [field], requiredScopes: [] };
    expect(() => parsePluginDefinition({ ...definition, connections: [{ ...definition.connections[0], setup }] })).toThrow("Environment setup fields");
  });
});

test("local MCP processes cannot inherit server or unrelated provider secrets", () => {
  expect(scopedProcessEnvironment({ PATH: "/bin", HOME: "/home/bot", DATABASE_URL: "private-db", OPENAI_API_KEY: "private-key", OPENTEAM_CONTROL_TOKEN: "control" },
    { PLUGIN_KEY: "configured" })).toEqual({ PATH: "/bin", HOME: "/home/bot", PLUGIN_KEY: "configured" });
});

test("skill folders supply bodies", () => {
  const definition = importPackage(files).definition;
  expect(importPackage({
    "plugin.json": JSON.stringify({ ...definition, skills: [{ name: "review", description: "Review", path: "skills/review" }] }),
    "skills/review/SKILL.md": "---\nname: review\ndescription: Review\n---\nRead supporting files.",
  }).definition.skills[0]?.body).toBe("Read supporting files.");
});

const example = () => {
  const definition = createPluginTemplate("packaged-mcp", "oauth-example");
  definition.connections[0]!.auth = "oauth";
  definition.connections[0]!.oauth = {
    registration: "manual",
    clientType: "confidential",
    tokenEndpointAuthMethod: "client_secret_post",
    accessTokenEnv: "PROVIDER_ACCESS_TOKEN",
    authorizationServer: {
      issuer: "https://provider.example",
      authorizationUrl: "https://provider.example/authorize",
      tokenUrl: "https://provider.example/token",
    },
  };
  return definition;
};

test("packaged OAuth rejects unsafe endpoints and incomplete token delivery configuration", () => {
  expect(parsePluginDefinition(example()).connections[0]!.auth).toBe("oauth");
  for (const tokenUrl of [
    "http://provider.example/token",
    "https://user:pass@provider.example/token",
    "https://provider.example/token#fragment",
  ]) {
    const definition = example();
    definition.connections[0]!.oauth!.authorizationServer!.tokenUrl = tokenUrl;
    expect(() => parsePluginDefinition(definition)).toThrow();
  }
  const missingEnv = example();
  missingEnv.connections[0]!.oauth!.accessTokenEnv = "BAD-NAME";
  expect(() => parsePluginDefinition(missingEnv)).toThrow("environment variable");
  const dynamic = example();
  dynamic.connections[0]!.oauth!.registration = "dynamic";
  expect(() => parsePluginDefinition(dynamic)).toThrow("manual client");
});

test("MCP URL fields normalize reachable schemes and reject credential-bearing or insecure links", () => {
  const field = [{ key: "url", label: "MCP URL", format: "mcp-url" as const, required: true, secret: false }];
  for (const value of ["https://environment.example/mcp", "http://localhost:3773/mcp", "http://127.0.0.1:3773/mcp", "http://[::1]:3773/mcp"])
    expect(validateValues(field, { url: ` ${value} ` }).url).toBe(value);
  for (const value of ["AUTO-example", "environment.example/mcp", "http://100.64.1.2:3773/mcp", "http://192.168.1.2:3773/mcp", "https://user:pass@example.com/mcp",
    "https://example.com/pair#code=private", "https://example.com/mcp#", "https://example.com/mcp?token=private", "https://example.com/mcp?code=private",
    "file:///tmp/mcp", "javascript:alert(1)"])
    expect(() => validateMcpUrl(value)).toThrow();
});

test("malformed skill metadata fails before saving", () => {
  expect(() => parseSkillMarkdown("---\nname: [unterminated\n---\nbody")).toThrow("frontmatter");
  expect(() => parseSkillMarkdown("---\nname: 12\n---\nbody")).toThrow("must be text");
  expect(() => parseSkillMarkdown("---\n- list\n---\nbody")).toThrow("mapping");
});

test("a newer colliding connection gets a short id suffix and the older keeps its name", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));
  const older = { id: "11111111-aaaa-4000-8000-000000000001", name: "Linear", alias: "default", createdAt: at(1) };
  const newer = { id: "22222222-bbbb-4000-8000-000000000002", name: "linear", alias: "default", createdAt: at(2) };
  const cursor = { id: "33333333-cccc-4000-8000-000000000003", name: "Cursor", alias: "default", createdAt: at(3) };
  const names = connectionNamespaces([newer, cursor, older]);
  expect([names.get(older.id), names.get(newer.id), names.get(cursor.id)]).toEqual(["linear", "linear-222222", "cursor-333333"]); // "cursor" is reserved
  expect(connectionNamespaces([{ id: "x", name: "★", alias: "☆", createdAt: at(1) }]).get("x")).toBe("connector--account");
});

test("tool byte fields accept large valid attachments and reject malformed base64", () => {
  const validate = createToolValidator({ type: "object", properties: { content: { type: "string", format: "byte" }, date: { type: "string", format: "date-time" } }, required: ["content"], additionalProperties: false });
  expect(validate({ content: Buffer.alloc(9 * 1024 * 1024, 42).toString("base64") }).valid).toBe(true);
  for (const content of ["A", "AAA", "AA=A", "A===", "A_AA", "AA==\n", "?AAA"]) expect(validate({ content }).valid).toBe(false);
  expect(validate({ content: "AA==", date: "not-a-date" }).valid).toBe(false);
  expect(validate({ content: "AA==", extra: true }).valid).toBe(false);
});

test("hard-wrapped email bodies unwrap and HTML tags are found exactly like the reference", () => {
  for (const { body, expected } of emailBodies.unwrap) expect(unwrapHardWrappedEmailBody(body)).toBe(expected);
  for (const { body, expected } of emailBodies.htmlTag) expect(emailBodyHtmlTag(body) ?? null).toBe(expected);
});
