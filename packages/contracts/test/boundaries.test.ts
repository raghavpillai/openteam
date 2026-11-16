import { expect, test } from "bun:test";
import { normalizeInferenceProviderId } from "../src/inference";
import { messagePreviewText } from "../src/message-preview";
import { MESSAGES_SEND_MAX_BYTES, validateMessagesSendFiles } from "../src/messages-send";
import { suppressMobileNotification } from "../src/notification-presence";
import { pluginDynamicNamespaces } from "../src/plugin-namespaces";
import { readLimitNotice, renderReadText } from "../src/read-output";
import { parseComputerInferenceRequest } from "../src/service-protocol";
import { validateTaskProgress } from "../src/task-progress";

test("Read applies the limit before line numbering and bounds huge line counts", () => {
  expect(renderReadText("a".repeat(100_000))).toMatchObject({ exceededLimit: false, text: `     1|${"a".repeat(100_000)}` });
  expect(renderReadText("a".repeat(100_001))).toMatchObject({ exceededLimit: true, text: readLimitNotice(100_001) });
  const lines = renderReadText("x\n".repeat(1_000_000));
  expect(lines.lines).toBe(1_000_001);
  expect(lines.text).toBe(readLimitNotice(2_000_000));
});

test("private attachment payloads enforce safe filenames, base64 and a combined byte budget", () => {
  const file = { fileName: "report.pdf", bytesBase64: Buffer.from("%PDF-1.7\nfixture").toString("base64") };
  expect(validateMessagesSendFiles([file])).toEqual([file]);
  expect(validateMessagesSendFiles(undefined)).toEqual([]);
  for (const files of [[], Array(11).fill(file), [{ ...file, fileName: "../secret" }], [{ ...file, fileName: "a\\b" }], [{ ...file, fileName: "a\n.pdf" }],
    [{ ...file, bytesBase64: "!!!!" }], [{ ...file, bytesBase64: "abc" }], [null]])
    expect(() => validateMessagesSendFiles(files)).toThrow();
  // Exercise a real maximum-size base64 string, including its final padded quantum.
  const full = { ...file, bytesBase64: Buffer.alloc(MESSAGES_SEND_MAX_BYTES).toString("base64") };
  expect(validateMessagesSendFiles([full])).toHaveLength(1);
  expect(() => validateMessagesSendFiles([full, file])).toThrow("25 MiB");
});

test("inference requests need a safe provider and an explicit runtime model", () => {
  for (const id of ["not valid", "../provider"]) expect(() => normalizeInferenceProviderId(id)).toThrow("Invalid inference provider");
  const request = { kind: "verification", instructions: "Verify this response.", prompt: "Return JSON.", timeoutMs: 5_000 };
  expect(() => parseComputerInferenceRequest(request)).toThrow("Inference model is invalid");
  expect(parseComputerInferenceRequest({ ...request, model: "openai-codex/gpt-5.5", reasoning: "high" })).toMatchObject({ model: "openai-codex/gpt-5.5", reasoning: "high" });
});

test("task progress needs evidence and resolved obligations and stays bounded", () => {
  const milestone = { key: "phase-1", state: "working" as const, summary: "The export is generated", evidence: ["/exports/receipt-1"], remaining: ["Verify delivery"], nextAction: "Check destination receipt" };
  const now = Date.parse("2026-01-01T00:00:00Z");
  expect(() => validateTaskProgress({ ...milestone, evidence: [] }, now)).toThrow("evidence");
  expect(() => validateTaskProgress({ ...milestone, state: "complete" }, now)).toThrow("unresolved");
  expect(() => validateTaskProgress({ ...milestone, nextAction: " " }, now)).toThrow("nextAction");
  expect(() => validateTaskProgress({ ...milestone, evidence: Array(20).fill("x".repeat(2000)) }, now)).toThrow("32000");
});

test("foreground iPhone wins simultaneous activity; preference and expiry restore delivery", () => {
  const routing = { smartEnabled: true, serverTime: 10_000, macActiveUntil: 70_000, iosActiveUntil: 0 };
  expect(suppressMobileNotification(routing)).toBeTrue();
  expect(suppressMobileNotification({ ...routing, iosActiveUntil: 70_000 })).toBeFalse();
  expect(suppressMobileNotification(routing, 70_000)).toBeFalse();
  expect(suppressMobileNotification({ ...routing, smartEnabled: false })).toBeFalse();
});

test("plugin namespaces carry the account and a not-ready reason, never saved instructions", () => {
  const connection = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, name: "Gmail", alias: "default", connectorKey: "gmail", status: "ready", statusMessage: null, instructions: "",
    toolSnapshot: [{ name: "search_threads", description: "Search", inputSchema: { type: "object" } }], installation: { pluginKey: "gmail" }, ...overrides,
  });
  const [ready, signedOut] = pluginDynamicNamespaces([
    connection("a", { instructions: "Reply in threads.", statusMessage: "stale" }),
    connection("b", { alias: "work", status: "needs_auth", statusMessage: "Sign in again" }),
  ], new Map([["a", "gmail"], ["b", "gmail--work"]]));
  expect(ready).toEqual({
    name: "gmail", description: "Gmail (default)", namespaceStatus: "ready", fileTransfers: { upload: true, download: true },
    tools: [{ connectionId: "a", name: "search_threads", description: "Search", inputSchema: { type: "object" }, source: "gmail/gmail" }],
  });
  expect(signedOut).toMatchObject({ name: "gmail--work", description: "Gmail (work)", namespaceStatus: "needsAuth", statusMessage: "Sign in again" });
});

test("message previews use the first visible line, strip markdown and cap at 200 characters", () => {
  for (const [input, preview] of [
    ["Status update\nAll three invoices are paid.\n\nDetails follow.", "Status update"],
    ["\n \n## Weekly audit\n\n### Summary\n- **UTC:** now", "Weekly audit"],
    ["- **Rent:** paid\n- **Utilities:** due Friday", "Rent: paid"],
    ["> Hi Sam, thanks for the update.\n\nWant me to send it?", "Hi Sam, thanks for the update."],
    ["| Item | Cost |\n|---|---|\n| Rent | $2,000 |", "Item Cost"],
    ["![Revenue chart](https://example.com/chart.png)\n\nUp 12%.", "Revenue chart"],
    ["```bash\nnpm run build\n```", "bash"],
    ["```\nnpm run build\n```", "npm run build"],
    ["---\n\nAfter the rule.", "---"],
    ["![](https://x.test/chart.png)\n\nRevenue grew 12%", "Revenue grew 12%"],
    ["<br>\n> \nStill here", "Still here"],
    [`Done. Here is the [quarterly revenue workbook](https://docs.google.com/spreadsheets/d/${"a".repeat(180)}/edit) for you to review.`, "Done. Here is the quarterly revenue workbook for you to review."],
    [`${"a".repeat(198)}😀😀`, `${"a".repeat(198)}…`],
  ])
    expect(messagePreviewText(input!)).toBe(preview!);
  const words = messagePreviewText(`${"word ".repeat(60)}end`);
  expect(words).toHaveLength(200);
  expect(words.endsWith("word…")).toBe(true);
});
