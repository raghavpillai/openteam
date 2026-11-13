import { expect, test } from "bun:test";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { fieldsForConnector, substituteConfiguration, validatePackageFiles, validateValues } from "@openteam/plugin-sdk";
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

test("WhatsApp connects with no setup parameters, using the same QR lifecycle as Signal", () => {
  const plugin = pluginCatalog.find((entry) => entry.key === "whatsapp")!;
  const signal = pluginCatalog.find((entry) => entry.key === "signal")!;
  expect(plugin.setup!.fields).toEqual(signal.setup!.fields);
  expect(fieldsForConnector(plugin, "whatsapp")).toEqual([]);
  const values = validateValues(fieldsForConnector(plugin, "whatsapp"), {});
  const connector = plugin.connections[0]!;
  const configuration = substituteConfiguration(connector.configuration, { ...values, PLUGIN_ROOT: "/installed/plugin" });
  expect(configuration).toEqual({ command: "bun", args: ["/installed/plugin/connector/server.mjs"] });
  expect(Object.keys(connector.deviceLink!).sort()).toEqual(Object.keys(signal.connections[0]!.deviceLink!).sort());
  const runtime = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "account" }, "/home/box");
  expect(runtime.readOnly).toBe(false);
  expect(runtime.maxMessages).toBe(100000);
  expect(runtime.mediaRoot).toBe("/workspace");
});
