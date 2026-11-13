import { expect, test } from "bun:test";
import { connectorRecord, reviewedSendResult } from "../src/services/external-draft-result";

test("JSON primitive strings cannot fall through into successful send IDs", () => {
  for (const raw of ["false", "null", "true", false, null, true, 12, "\"false\"", "{\"ok\":false}", "{\"error\":\"refused\"}"])
    expect(() => connectorRecord(raw)).toThrow();
  for (const id of ["sent-1", "123456789012345678901234567890", "1e3", "12E34", "1e-3"])
    expect(connectorRecord(id)).toEqual({ id });
  expect(connectorRecord(JSON.stringify({ id: "sent-1" }))).toEqual({ id: "sent-1" });
});

test("malformed MCP envelopes and metadata alone cannot establish successful results", () => {
  for (const raw of [
    {}, [], { structuredContent: null }, { structuredContent: false }, { structuredContent: "{\"id\":\"sent\"}" },
    { structuredContent: [] }, { content: null }, { content: {} }, { content: "sent" },
    { content: [] }, { content: [null] }, { content: [{ type: "text", text: false }] },
    { content: [{ type: "image", data: "fixture" }] }, { content: [{ type: "text", text: "false" }] },
    { isError: false }, { _meta: { trace: "fixture" }, isError: false }, { annotations: {} },
    { isError: true, structuredContent: { id: "sent" } }, { error: "refused", id: "sent" },
    { structuredContent: { id: "sent" }, content: null },
  ]) expect(() => connectorRecord(raw)).toThrow();
});

test("supported MCP structured and JSON text envelopes preserve connector data", () => {
  const result = { id: "sent-1", threadId: "thread-1" };
  expect(connectorRecord({ structuredContent: result, content: [{ type: "text", text: "Summary only" }] })).toEqual(result);
  expect(connectorRecord({ isError: false, content: [{ type: "text", text: JSON.stringify(result) }] })).toEqual(result);
  expect(connectorRecord({ content: [{ type: "text", text: JSON.stringify({ structuredContent: result }) }] })).toEqual(result);
  expect(connectorRecord({ structuredContent: { identity: "me@example.com", sendingAddresses: ["me@example.com"] } })).toEqual({ identity: "me@example.com", sendingAddresses: ["me@example.com"] });
});

test("reviewed Gmail and fully accepted SMTP receipts confirm the intended recipients", () => {
  for (const raw of ["sent-1", "12345678901234567890", "1e3", "12E34", { id: "sent-1", threadId: "thread-1", labelIds: ["SENT"] },
    { content: [{ type: "text", text: JSON.stringify({ id: "sent-1" }) }] }])
    expect(reviewedSendResult(raw, "email").id).toEqual(expect.any(String));
  const smtp = { messageId: "<sent@example.com>", accepted: ["Ann@Example.com", "copied@example.com"], rejected: [] };
  expect(reviewedSendResult(smtp, "email", ["ann@example.com", "COPIED@example.com"])).toEqual(smtp);
  expect(reviewedSendResult({ accepted: ["ann@example.com"], rejected: [] }, "email", ["ann@example.com"])).toMatchObject({ accepted: ["ann@example.com"] });
});

test("partial SMTP acceptance and unrelated records cannot confirm a reviewed email", () => {
  for (const raw of [
    { unrelated: "not a send receipt" }, { identity: "me@example.com" }, { ok: true }, { id: "" },
    { accepted: [], rejected: [] }, { accepted: ["ann@example.com"], rejected: ["copied@example.com"] },
    { id: "must-not-bypass-smtp", accepted: [], rejected: [] },
    { id: "must-not-bypass-partial", accepted: ["ann@example.com"], rejected: ["copied@example.com"] },
    { accepted: ["ann@example.com"] }, { rejected: [] }, { accepted: [null], rejected: [] },
    { accepted: [""], rejected: [] }, { accepted: ["ann@example.com"], rejected: null },
    { messageId: "not-enough-by-itself" },
  ]) expect(() => reviewedSendResult(raw, "email", ["ann@example.com", "copied@example.com"])).toThrow();
  expect(() => reviewedSendResult({ accepted: ["ann@example.com"], rejected: [] }, "email", ["ann@example.com", "copied@example.com"])).toThrow();
});

test("managed Slack opaque successful records remain compatible while malformed wrappers are refused", () => {
  // These are compatibility probes, not claims about the remote server's schema.
  for (const result of [{ result: "opaque managed reply" }, { message: "opaque managed reply" }, { ok: true }, { id: "fixture" }])
    expect(reviewedSendResult(result, "slack")).toEqual(result);
  for (const result of [{ isError: false }, { structuredContent: null }, { content: null }])
    expect(() => reviewedSendResult(result, "slack")).toThrow();
});
