import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultStore } from "../_shared/results";
import { referenceTools } from "../_shared/reference";
import { gmailTools } from "../gmail/connector/server";
import { calendarTools } from "../google-calendar/connector/server";
import { driveTools } from "../google-drive/connector/server";
import { docsTools } from "../google-docs/connector/server";
import { sheetsTools } from "../google-sheets/connector/server";
import { slidesTools } from "../google-slides/connector/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

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

test("Every advertised reference tool input remains discoverable with valid MCP schemas", () => {
  const factories = { gmail: gmailTools, calendar: calendarTools, drive: driveTools, driveFiles: driveTools, docs: docsTools, sheets: sheetsTools, slides: () => slidesTools() };
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
