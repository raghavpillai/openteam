import { expect, test } from "bun:test";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { substituteConfiguration, validatePackageFiles, validateValues } from "@openteam/plugin-sdk";
import { settings } from "../process";
import { pluginCatalog } from "../../../src";

test("WhatsApp exports below the package limit with both binaries and skills, without account state or test fixtures", () => {
  const plugin = pluginCatalog.find((entry) => entry.key === "whatsapp")!;
  expect(plugin).toBeDefined();
  expect(plugin.skills.map((skill) => skill.name)).toEqual(["whatsapp", "whatsapp-setup"]);
  expect(plugin.files?.["connector/server.mjs"]).toContain("openteam-whatsapp");
  expect(plugin.binaryFiles?.["connector/bin/linux-x64.br"]).toBeDefined();
  expect(plugin.binaryFiles?.["connector/bin/linux-arm64.br"]).toBeDefined();
  expect(plugin.upstream?.delivery).toBe("reference");
  // Older deployed computer runtimes count encoded binary strings as text.
  // Keep this package installable there while the decoded-byte fix rolls out.
  expect(() => validatePackageFiles(plugin.binaryFiles!)).not.toThrow();
  const keys = [...Object.keys(plugin.files ?? {}), ...Object.keys(plugin.binaryFiles ?? {})];
  expect(keys.some((path) => /(?:^|\/)(?:session\.db|wacli\.db|test|fixtures|node_modules)(?:\/|$)/.test(path))).toBe(false);
  const archive = exportPackageArchive(plugin);
  expect(archive.byteLength).toBeLessThan(20 * 1024 * 1024);
  const imported = importPackageArchive(archive).definition;
  expect(imported.skills).toEqual(plugin.skills);
  expect(imported.binaryFiles?.["connector/bin/linux-arm64.br"]).toBe(plugin.binaryFiles?.["connector/bin/linux-arm64.br"]);
});

test("typed account settings reach the connector through interpolated string options", () => {
  const plugin = pluginCatalog.find((entry) => entry.key === "whatsapp")!;
  const values = validateValues(plugin.setup!.fields, { WHATSAPP_READ_ONLY: true, WHATSAPP_MAX_MESSAGES: 4321 });
  const configuration = substituteConfiguration(plugin.connections[0]!.configuration, { ...values, PLUGIN_ROOT: "/installed/plugin" }) as { args: string[]; env: Record<string, string> };
  expect(configuration.args).toContain("--read-only=true");
  expect(configuration.args).toContain("--max-messages=4321");
  expect(Object.values(configuration.env).every((value) => typeof value === "string")).toBe(true);
  const runtime = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "account" }, "/home/box", { readOnly: "true", maxMessages: "4321" });
  expect(runtime.readOnly).toBe(true); expect(runtime.maxMessages).toBe(4321);
});
