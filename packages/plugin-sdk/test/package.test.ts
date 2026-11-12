import { describe, expect, test } from "bun:test";
import {
  createPluginTemplate,
  environmentFields,
  fieldsForConnector,
  importPackage,
  parsePluginDefinition,
  scopedProcessEnvironment,
} from "../src";

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
    for (const path of [
      "../../outside.json",
      "../nested/../../outside.json",
      "/tmp/config.json",
      "..\\config.json",
      "https://example.com/config.json",
    ]) {
      expect(() =>
        importPackage({
          ".cursor-plugin/plugin.json": JSON.stringify({
            name: "unsafe",
            version: "1.0.0",
            mcpServers: path,
          }),
          "outside.json": "{}",
        })
      ).toThrow("Unsafe package path");
    }
    expect(() =>
      importPackage({
        "plugin.json": JSON.stringify({
          name: "unsafe",
          version: "1.0.0",
          mcpServers: "../outside.json",
        }),
        "outside.json": "{}",
      })
    ).toThrow("Unsafe package path");
  });
  test("accepts reviewed draft sending only on packaged connectors", () => {
    const definition = importPackage(files).definition;
    const local = definition.connections.find((connection) => connection.transport === "stdio")!;
    const remote = definition.connections.find((connection) => connection.transport === "http")!;
    const withDrafts = (connection: typeof local, drafts: unknown) =>
      parsePluginDefinition({ ...definition, connections: [{ ...connection, drafts }] });
    expect(withDrafts(local, { platform: "email", tool: "send_reviewed_email" }).connections[0]!.drafts).toEqual({
      platform: "email",
      tool: "send_reviewed_email",
    });
    expect(() => withDrafts(remote, { platform: "email", tool: "send" })).toThrow("Only packaged (stdio)");
    expect(() => withDrafts(local, { platform: "slack", tool: "send" })).toThrow("Unknown draft platform: slack");
    expect(() => withDrafts(local, { platform: "email" })).toThrow("draft send tool");
  });
  test("rejects traversal, private files, invalid transports, and secret defaults", () => {
    expect(() => importPackage({ ...files, "../secret": "x" })).toThrow("Unsafe package path");
    expect(() => importPackage({ ...files, ".env": "TOKEN=x" })).toThrow("private or generated");
    const definition = importPackage(files).definition;
    expect(() =>
      parsePluginDefinition({
        ...definition,
        connections: [{ ...definition.connections[0], transport: "shell" }],
      })
    ).toThrow("Unsupported connector");
    expect(() =>
      parsePluginDefinition({
        ...definition,
        setupFields: [
          { key: "TOKEN", label: "Token", secret: true, required: true, default: "secret" },
        ],
      })
    ).toThrow("Secret defaults");
  });
  test("environment setup fields are unique plugin-level secrets kept from connectors", () => {
    const definition = importPackage(files).definition;
    const field = { key: "API_TOKEN", label: "Token", secret: true, required: true, environment: "SERVICE_TOKEN" };
    const parsed = parsePluginDefinition({ ...definition, setupFields: [field] });
    expect(environmentFields(parsed)).toEqual([field]);
    expect(fieldsForConnector(parsed, parsed.connections[0]!.key).map((entry) => entry.key)).not.toContain("API_TOKEN");
    for (const setupFields of [
      [{ ...field, key: "REGION", secret: false }],
      [field, { ...field, key: "OTHER_TOKEN" }],
      [{ ...field, environment: "1INVALID" }],
      [{ ...field, environment: "NODE_OPTIONS" }],
      [{ ...field, environment: "PATH" }],
    ])
      expect(() => parsePluginDefinition({ ...definition, setupFields })).toThrow("Environment setup fields");
    const setup = { kind: "none", connectionKey: null, title: "Setup", description: "Setup", documentationUrl: null, steps: [], fields: [field], requiredScopes: [] };
    expect(() =>
      parsePluginDefinition({ ...definition, connections: [{ ...definition.connections[0], setup }] })
    ).toThrow("Environment setup fields");
  });
});

test("local MCP processes cannot inherit server or unrelated provider secrets", () => {
  expect(
    scopedProcessEnvironment(
      {
        PATH: "/bin",
        HOME: "/home/bot",
        DATABASE_URL: "private-db",
        OPENAI_API_KEY: "private-key",
        OPENTEAM_CONTROL_TOKEN: "control",
      },
      { PLUGIN_KEY: "configured" }
    )
  ).toEqual({ PATH: "/bin", HOME: "/home/bot", PLUGIN_KEY: "configured" });
});

test("skill folders supply bodies and imports reject literal credentials", () => {
  const definition = importPackage(files).definition;
  expect(
    importPackage({
      "plugin.json": JSON.stringify({
        ...definition,
        skills: [{ name: "review", description: "Review", path: "skills/review" }],
      }),
      "skills/review/SKILL.md":
        "---\nname: review\ndescription: Review\n---\nRead supporting files.",
    }).definition.skills[0]?.body
  ).toBe("Read supporting files.");
  expect(() =>
    parsePluginDefinition({
      ...definition,
      connections: [
        {
          ...definition.connections[0],
          configuration: { headers: { Authorization: "Bearer real-token" } },
        },
      ],
    })
  ).toThrow("literal secret");
  expect(() =>
    parsePluginDefinition({ ...definition, binaryFiles: { "../escape": "YWJj" } })
  ).toThrow("Unsafe package path");
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
