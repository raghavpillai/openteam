import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enabledTools, executableBytes, sessionEnvironment } from "../server";
import { fieldsForConnector, validateValues, validatePackageFiles } from "@openteam/plugin-sdk";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { pluginCatalog } from "../../../src";

const packageRoot = join(import.meta.dir, "../..");
const plugin = () => pluginCatalog.find((entry) => entry.key === "slack-stealth")!;

test("managed keeps its account identity and stealth ships independent required secrets", () => {
  const managed = pluginCatalog.find((entry) => entry.key === "slack")!;
  expect(managed.name).toBe("Slack (managed)");
  expect(managed.connections[0]?.key).toBe("slack");
  expect(managed.connections[0]?.auth).toBe("oauth");
  const stealth = plugin();
  expect(stealth.name).toBe("Slack (stealth)");
  expect(stealth.connections[0]?.transport).toBe("stdio");
  expect(stealth.connections[0]?.oauth).toBeUndefined();
  const fields = fieldsForConnector(stealth, "slack-stealth");
  expect(fields).toHaveLength(2);
  expect(fields.every((field) => field.required && field.secret)).toBe(true);
  expect(() => validateValues(fields, {})).toThrow("Slack browser token is required");
  expect(() => validateValues(fields, { SLACK_BROWSER_TOKEN: "xoxc-fixture" })).toThrow("Slack session cookie is required");
});

test("session credentials are validated without leaking values or inheriting other auth modes", () => {
  const credentials = { SLACK_MCP_XOXC_TOKEN: "xoxc-synthetic", SLACK_MCP_XOXD_TOKEN: "xoxd-synthetic" };
  const env = sessionEnvironment({ ...credentials, PATH: "/bin", SLACK_MCP_XOXP_TOKEN: "other-user-secret", SLACK_MCP_PROXY: "unwanted-proxy", SLACK_MCP_ENABLED_TOOLS: "usergroups_create" });
  expect(env.SLACK_MCP_XOXC_TOKEN).toBe(credentials.SLACK_MCP_XOXC_TOKEN);
  expect(env.SLACK_MCP_XOXD_TOKEN).toBe(credentials.SLACK_MCP_XOXD_TOKEN);
  expect(env.PATH).toBe("/bin");
  expect(env.SLACK_MCP_XOXP_TOKEN).toBeUndefined();
  expect(env.SLACK_MCP_PROXY).toBeUndefined();
  expect(env.SLACK_MCP_ENABLED_TOOLS).toBe(enabledTools.join(","));
  for (const token of ["demo", "xoxp-secret", "xoxc-", "xoxc-secret\ninjected", "${SLACK_BROWSER_TOKEN}"]) {
    expect(() => sessionEnvironment({ ...credentials, SLACK_MCP_XOXC_TOKEN: token })).toThrow("Enter a valid Slack browser token");
  }
  for (const cookie of ["demo", "xoxd-", "xoxd-secret;other=cookie", "${SLACK_SESSION_COOKIE}"]) {
    expect(() => sessionEnvironment({ ...credentials, SLACK_MCP_XOXD_TOKEN: cookie })).toThrow("Enter a valid Slack session cookie");
  }
});

test("both bundled architectures verify and tampered archives are rejected", async () => {
  for (const architecture of ["x64", "arm64"]) {
    const bytes = await executableBytes(packageRoot, "linux", architecture);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("7f454c46");
  }
  await expect(executableBytes(packageRoot, "darwin", "arm64")).rejects.toThrow("requires an OpenTeam Linux computer");
  const directory = await mkdtemp(join(tmpdir(), "slack-integrity-test-"));
  try {
    await mkdir(join(directory, "connector/bin"), { recursive: true });
    const bytes = await readFile(join(packageRoot, "connector/bin/linux-arm64.gz"));
    bytes[0] = 0;
    await writeFile(join(directory, "connector/bin/linux-arm64.gz"), bytes);
    await expect(executableBytes(directory, "linux", "arm64")).rejects.toThrow("archive verification failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable export contains the executable and both verified archives within package limits", () => {
  const original = plugin();
  expect(() => validatePackageFiles(original.binaryFiles!)).not.toThrow();
  const imported = importPackageArchive(exportPackageArchive(original)).definition;
  expect(imported.files?.["connector/server.mjs"]).toContain("Slack MCP archive verification failed");
  expect(imported.binaryFiles?.["connector/bin/linux-x64.gz"]).toBe(original.binaryFiles?.["connector/bin/linux-x64.gz"]);
  expect(imported.binaryFiles?.["connector/bin/linux-arm64.gz"]).toBe(original.binaryFiles?.["connector/bin/linux-arm64.gz"]);
  expect(imported.setup?.fields.every((field) => field.secret && field.default === undefined)).toBe(true);
  expect(imported.files?.["upstream/cmd/slack-mcp-server/main.go"]).toContain("package main");
  expect(imported.files?.["upstream/go.mod"]).toContain("module github.com/korotovsky/slack-mcp-server");
  expect(imported.files?.["upstream/LICENSE"]).toContain("Copyright (c) 2025 Dmitrii Korotovskii");
  expect(imported.files?.["NOTICE.md"]).toContain("MIT license");
  expect(JSON.parse(imported.files!["connector/release.json"]!).build.toolchain).toBe("go1.25.9");
});
