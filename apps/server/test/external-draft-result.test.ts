import { expect, test } from "bun:test";
import { connectorRecord, reviewedSendResult } from "../src/services/external-draft-result";

test("only real MCP or JSON records count as connector results", () => {
  // JSON primitives, metadata alone, error flags and malformed envelopes never become a send ID.
  for (const raw of ["false", "null", true, 12, "{\"ok\":false}", "{\"error\":\"refused\"}", {}, [], { structuredContent: null },
    { structuredContent: "{\"id\":\"sent\"}" }, { content: [] }, { content: [{ type: "text", text: "false" }] }, { content: [{ type: "image", data: "x" }] },
    { isError: false }, { isError: true, structuredContent: { id: "sent" } }, { error: "refused", id: "sent" }, { structuredContent: { id: "sent" }, content: null }])
    expect(() => connectorRecord(raw)).toThrow();
  for (const id of ["sent-1", "123456789012345678901234567890", "1e3"]) expect(connectorRecord(id)).toEqual({ id });
  const result = { id: "sent-1", threadId: "thread-1" };
  expect(connectorRecord(JSON.stringify(result))).toEqual(result);
  expect(connectorRecord({ structuredContent: result, content: [{ type: "text", text: "Summary only" }] })).toEqual(result);
  expect(connectorRecord({ isError: false, content: [{ type: "text", text: JSON.stringify({ structuredContent: result }) }] })).toEqual(result);
});

test("a reviewed email is confirmed only by a Gmail ID or SMTP acceptance of every recipient", () => {
  const recipients = ["ann@example.com", "copied@example.com"];
  for (const raw of ["sent-1", { id: "sent-1", labelIds: ["SENT"] }, { content: [{ type: "text", text: JSON.stringify({ id: "sent-1" }) }] }])
    expect(reviewedSendResult(raw, "email").id).toEqual(expect.any(String));
  const smtp = { messageId: "<sent@example.com>", accepted: ["Ann@Example.com", "copied@example.com"], rejected: [] };
  expect(reviewedSendResult(smtp, "email", ["ann@example.com", "COPIED@example.com"])).toEqual(smtp);
  for (const raw of [{ unrelated: "x" }, { identity: "me@example.com" }, { ok: true }, { id: "" }, { accepted: [], rejected: [] },
    { id: "must-not-bypass-partial", accepted: ["ann@example.com"], rejected: ["copied@example.com"] },
    { accepted: ["ann@example.com"], rejected: [] }, { accepted: [""], rejected: [] }, { accepted: recipients, rejected: null }, { messageId: "alone" }])
    expect(() => reviewedSendResult(raw, "email", recipients)).toThrow();
  // IDN domains match in either form; local parts never change.
  const idn = { accepted: ["ann@xn--bcher-kva.example", "δοκιμή@xn--hxajbheg2az3al.example"], rejected: [] };
  expect(reviewedSendResult(idn, "email", ["ann@bücher.example", "δοκιμή@παράδειγμα.example"])).toBe(idn);
  for (const other of ["other@bücher.example", "ann@other.example", "dokimi@παράδειγμα.example"]) expect(() => reviewedSendResult(idn, "email", [other])).toThrow();
});

test("managed Slack opaque records are accepted while malformed wrappers are refused", () => {
  for (const result of [{ result: "opaque managed reply" }, { ok: true }, { id: "fixture" }]) expect(reviewedSendResult(result, "slack")).toEqual(result);
  for (const result of [{ isError: false }, { structuredContent: null }, { content: null }]) expect(() => reviewedSendResult(result, "slack")).toThrow();
});
