import { describe, expect, test } from "bun:test";
import {
  applySecretEdits,
  connectionNamespace,
  discoverAllTools,
  effectiveToolPolicy,
  exportPackage,
  importPackage,
  parsePluginDefinition,
  pluginIconUrl,
  scopedProcessEnvironment,
  substituteConfiguration,
  validateValues,
} from "../src";
import { exportPackageArchive, importPackageArchive } from "../src/archive";

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
  test("imports hybrid packages with typed variables and retains relative skill assets", () => {
    const preview = importPackage(files);
    expect(preview.format).toBe("agent-plugin");
    expect(preview.definition.components).toEqual(["mcp", "skills"]);
    expect(preview.definition.connections[1]?.configuration?.args).toEqual(["a b", 'quoted"value']);
    expect(preview.definition.skills[0]?.path).toBe("skills/review");
    expect(preview.definition.setupFields?.[0]?.secret).toBe(true);
    const roundtrip = importPackage(exportPackage(preview.definition));
    expect(roundtrip.definition.skills).toEqual(preview.definition.skills);
    expect(roundtrip.definition.files?.["skills/review/references/style.md"]).toBe(
      "Preserve evidence."
    );
  });
  test("ZIP round trips binary supporting files without touching account credentials", () => {
    const definition = importPackage(files).definition;
    definition.binaryFiles = { "skills/review/assets/sample.bin": btoa("\u0000\u00ff\u0080") };
    const imported = importPackageArchive(exportPackageArchive(definition));
    expect(imported.definition.binaryFiles).toEqual(definition.binaryFiles);
    expect(imported.definition.connections[0]?.configuration?.headers).toEqual({
      Authorization: "Bearer ${API_TOKEN}",
    });
  });
  test("package icons survive ZIP import and export and take precedence over hosted logos", () => {
    const definition = importPackage(files).definition;
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG0cAAAAASUVORK5CYII=";
    definition.icon = "assets/icon.png";
    definition.logoUrl = "https://example.com/legacy.png";
    definition.binaryFiles = { "assets/icon.png": png };
    const imported = importPackageArchive(exportPackageArchive(definition)).definition;
    expect(imported.icon).toBe("assets/icon.png");
    expect(pluginIconUrl(imported)).toBe(`data:image/png;base64,${png}`);
    expect(() => parsePluginDefinition({ ...definition, binaryFiles: {} })).toThrow(
      "Missing plugin icon"
    );
    expect(() => parsePluginDefinition({ ...definition, icon: "../icon.png" })).toThrow(
      "Unsafe package path"
    );
    expect(() => parsePluginDefinition({ ...definition, icon: "assets/icon.svg" })).toThrow(
      "PNG, JPEG or WebP"
    );
    expect(() =>
      parsePluginDefinition({
        ...definition,
        binaryFiles: { "assets/icon.png": "AAAA".repeat(90_000) },
      })
    ).toThrow("256 KB");
  });
  test("icon resolution retains legacy image URLs and lets clients render a missing-image fallback", () => {
    for (const logoUrl of [
      "https://example.com/icon.svg",
      "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
    ])
      expect(pluginIconUrl({ logoUrl })).toBe(logoUrl);
    expect(pluginIconUrl({})).toBeNull();
    expect(pluginIconUrl({ logoUrl: "javascript:alert(1)" })).toBeNull();
    expect(
      pluginIconUrl({ icon: "assets/missing.png", logoUrl: "https://example.com/icon.png" })
    ).toBe("https://example.com/icon.png");
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
  test("retains Cursor hook configuration for runtime execution", () => {
    const { "plugin.json": manifest, ...rest } = files;
    const preview = importPackage({
      ...rest,
      ".cursor-plugin/plugin.json": JSON.stringify({
        ...JSON.parse(manifest),
        hooks: "hooks/hooks.json",
      }),
      "hooks/hooks.json": "{}",
    });
    expect(preview.format).toBe("cursor-plugin");
    expect(preview.warnings).toEqual([]);
    expect(preview.definition.files?.["hooks/hooks.json"]).toBe("{}");
  });
});

test("configuration validates scalar types and preserves exact values", () => {
  const fields = [
    {
      key: "COUNT",
      label: "Count",
      type: "integer" as const,
      required: true,
      secret: false,
      default: 3,
    },
    { key: "ENABLED", label: "Enabled", type: "boolean" as const, required: true, secret: false },
  ];
  expect(validateValues(fields, { ENABLED: false })).toEqual({ COUNT: 3, ENABLED: false });
  expect(() => validateValues(fields, { COUNT: "3", ENABLED: true })).toThrow("must be integer");
  expect(
    substituteConfiguration(
      { count: "${COUNT}", flag: "${ENABLED}", argument: "--count=${COUNT}" },
      { COUNT: 3, ENABLED: false }
    )
  ).toEqual({ count: 3, flag: false, argument: "--count=3" });
  expect(
    applySecretEdits(
      { keep: "first", replace: "old", clear: "gone" },
      {
        keep: { action: "keep" },
        replace: { action: "replace", value: "new" },
        clear: { action: "clear" },
      }
    )
  ).toEqual({ keep: "first", replace: "new" });
});
test("account namespaces and tool permissions are independent of display names", () => {
  expect(connectionNamespace("id-one")).not.toBe(connectionNamespace("id-two"));
  expect(
    effectiveToolPolicy(
      [{ botId: null, toolName: "read", enabled: false, decision: "allow" }],
      "read",
      "bot",
      "allow"
    )
  ).toEqual({ enabled: false, decision: "allow" });
  expect(
    effectiveToolPolicy(
      [
        { botId: null, toolName: "read", decision: "deny" },
        { botId: "bot", toolName: "read", decision: "allow" },
      ],
      "read",
      "bot",
      "allow"
    ).decision
  ).toBe("deny");
});
test("MCP discovery follows pages and rejects repeated cursors", async () => {
  const seen: Array<string | undefined> = [];
  expect(
    await discoverAllTools(async (cursor) => {
      seen.push(cursor);
      return cursor
        ? { tools: [{ name: "second" }] }
        : { tools: [{ name: "first" }], nextCursor: "next" };
    })
  ).toEqual([{ name: "first" }, { name: "second" }]);
  expect(seen).toEqual([undefined, "next"]);
  await expect(discoverAllTools(async () => ({ tools: [], nextCursor: "loop" }))).rejects.toThrow(
    "pagination cursor"
  );
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

test("partial saves preserve omitted defaults and explicit clearing", () => {
  const fields = [
    { key: "VALUE", label: "Value", secret: false, required: false, default: "initial" },
  ];
  expect(validateValues(fields, {}, false)).toEqual({});
  expect(validateValues(fields, { VALUE: "" }, false)).toEqual({ VALUE: "" });
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
