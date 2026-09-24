import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultStore } from "../_shared/results";
import { referenceTools } from "../_shared/reference";
import { gmailTools } from "../gmail/connector/server";
import { calendarTools } from "../google-calendar/connector/server";
import { driveTools } from "../google-drive/connector/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { parsePluginDefinition, createPluginTemplate } from "@openteam/plugin-sdk";
import { pluginCatalog } from "../src";

test("Large tool results survive process replacement and are complete and account scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-result-test-"));
  try {
    const store = new ResultStore("provider", "account-a", root),
      other = new ResultStore("provider", "account-b", root);
    const original = { file: "large", content: "Unicode 🌎 and control \u0000\n".repeat(15000) };
    let page: any = await store.capture(original);
    expect(page.resultId).toBeTruthy();
    await expect(other.page(page.resultId)).rejects.toThrow("unavailable for this account");
    const replacement = new ResultStore("provider", "account-a", root);
    let assembled = "";
    while (true) {
      expect(JSON.stringify(page).length).toBeLessThan(75000);
      assembled += page.jsonFragment;
      if (page.nextOffset === null) break;
      page = await replacement.page(page.resultId, page.nextOffset);
    }
    expect(JSON.parse(assembled)).toEqual(original);
    await expect(store.page("../../outside")).rejects.toThrow("resultId");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("The binary package validator accepts real model-sized base64 and rejects malformed payloads", () => {
  const definition = createPluginTemplate("skills", "binary-test");
  definition.binaryFiles = {
    "assets/model.bin": Buffer.alloc(8 * 1024 * 1024, 1).toString("base64"),
  };
  expect(parsePluginDefinition(definition).binaryFiles?.["assets/model.bin"]).toBe(
    definition.binaryFiles["assets/model.bin"]
  );
  for (const invalid of ["a===", "abcd=", "ab!d", "ab=c"])
    expect(() =>
      parsePluginDefinition({ ...definition, binaryFiles: { "file.bin": invalid } })
    ).toThrow("binary file");
});

test("Every advertised reference tool input remains discoverable with valid MCP schemas", () => {
  const factories = { gmail: gmailTools, calendar: calendarTools, drive: driveTools };
  const validator = new AjvJsonSchemaValidator();
  for (const [provider, references] of Object.entries(referenceTools)) {
    const local = factories[provider as keyof typeof factories]();
    for (const reference of references) {
      const actual = local.find((t) => t.name === reference.name);
      expect(actual).toBeTruthy();
      for (const key of Object.keys(reference.inputSchema.properties))
        expect(actual!.inputSchema.properties).toHaveProperty(key);
      expect(validator.getValidator(actual!.inputSchema)({ unexpected: "field" }).valid).toBe(
        false
      );
    }
  }
});

test("Notion declares 14 source-fetched workflows and Calendar retains its local model", () => {
  const notion = pluginCatalog.find((p) => p.key === "notion")!;
  expect(notion.skills).toHaveLength(14);
  expect(notion.components).toEqual(["mcp", "skills"]);
  expect(notion.upstream?.delivery).toBe("install");
  for (const skill of notion.skills) {
    expect(skill.body).toBe("");
    expect(notion.files?.[`${skill.path}/SKILL.md`]).toBeUndefined();
  }
  expect(notion.files?.["README.md"]).toContain("14 original workflows");
  const calendar = pluginCatalog.find((p) => p.key === "google-calendar")!;
  expect(calendar.binaryFiles?.["models/potion-base-2M/model.safetensors"]).toBeTruthy();
});
