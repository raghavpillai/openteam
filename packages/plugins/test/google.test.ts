import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { GoogleApi } from "../_shared/google";
import { referenceTools } from "../_shared/reference";
import { ResultStore } from "../_shared/results";
import { gmailTools } from "../gmail/connector/server";
import { calendarTools } from "../google-calendar/connector/server";
import { docsTools } from "../google-docs/connector/server";
import { driveTools } from "../google-drive/connector/server";
import { sheetsTools } from "../google-sheets/connector/server";
import { slidesTools } from "../google-slides/connector/server";

const surfaces = {
  gmail: { tools: gmailTools, references: ["gmail"], extra: ["get_profile", "search_messages", "send_reviewed_email"] },
  calendar: { tools: calendarTools, references: ["calendar"], extra: [] },
  drive: { tools: driveTools, references: ["drive", "driveFiles"], extra: [] },
  docs: { tools: docsTools, references: ["docs"], extra: [] },
  sheets: { tools: sheetsTools, references: ["sheets"], extra: [] },
  slides: { tools: () => slidesTools(), references: ["slides"], extra: [] },
} as const;
// These follow the pinned definitions exactly; the others add inputs on top of them.
const exact = new Set(["driveFiles", "docs", "sheets", "slides"]);
const destructive = [
  "apply_sensitive_message_label", "apply_sensitive_thread_label", "batch_clear_values", "clear_range", "delete_chart",
  "delete_content", "delete_draft", "delete_event", "delete_named_range", "delete_object", "delete_rows_or_columns",
  "delete_sheet_tab", "mark_message_spam", "mark_thread_spam", "trash_file", "trash_message", "trash_thread", "unprotect_range",
];

test("Google tool surfaces match the pinned reference definitions, risk and strict schemas", () => {
  const validator = new AjvJsonSchemaValidator();
  const risky = new Set<string>();
  for (const { tools: factory, references, extra } of Object.values(surfaces)) {
    const tools = factory();
    const pinned = references.flatMap((provider) => referenceTools[provider].map((reference) => ({ provider, reference })));
    expect(tools.map((t) => t.name).sort()).toEqual([...new Set([...pinned.map(({ reference }) => reference.name), ...extra])].sort());
    for (const tool of tools) if (tool.annotations.destructiveHint) risky.add(tool.name);
    for (const { provider, reference } of pinned) {
      const tool = tools.find((t) => t.name === reference.name)!;
      for (const [key, schema] of Object.entries(reference.inputSchema.properties)) {
        expect(tool.inputSchema.properties).toHaveProperty(key);
        if (exact.has(provider)) expect(tool.inputSchema.properties[key]).toEqual(schema);
      }
      if (exact.has(provider)) {
        expect(tool.description).toBe(reference.description);
        expect(Boolean(tool.annotations.readOnlyHint)).toBe(Boolean(reference.annotations?.readOnlyHint));
      }
      expect(validator.getValidator(tool.inputSchema)({ unexpected: "field" }).valid).toBe(false);
    }
  }
  expect([...risky].sort()).toEqual(destructive);
});

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

test("Google API errors surface actionable messages and redact tokens", async () => {
  const api = new GoogleApi("https://www.googleapis.com", "secret-token", async () =>
    Response.json({ error: { message: "Denied secret-token" } }, { status: 403 })
  );
  await expect(api.request("/drive/v3/files")).rejects.toThrow("Google API 403: Denied [redacted]");
});
