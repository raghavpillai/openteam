import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { ComputerUseInput } from "../src";
import { parseReferenceArguments } from "../src/reference-parsers";
import { renderDesktopResult, renderControlResult } from "../src/tool-results";
import { renderReadText } from "../src/read-output";
import {
  describeUploadFileOutcome,
  describeDownloadFileOutcome,
  rankPluginsLexically,
  buildUserFormRemapReceipt,
} from "../src/reference-formatters";

// Fixed expectations transcribed from the captured reference, with synthetic IDs/data.
describe("reference result and parser fixtures", () => {
  test("Read reproduces both omission markers and six-column line numbers", () => {
    expect(renderReadText("one\ntwo\nthree\nfour\n", 2, 2).text).toBe(
      "... 1 lines not shown ...\n     2|two\n     3|three\n... 2 lines not shown ..."
    );
    expect(renderReadText("one\ntwo", -1).text).toBe("... 1 lines not shown ...\n     2|two");
  });
  test("optional schemas trim identifiers, strip unknown fields, and preserve message text", () => {
    expect(parseReferenceArguments("FindContacts", { query: " Ada ", ignored: true })).toEqual({
      query: "Ada",
    });
    expect(
      parseReferenceArguments("SendIMessage", { to: " +15555550100 ", text: "  hello  " })
    ).toEqual({ to: "+15555550100", text: "  hello  " });
    expect(
      parseReferenceArguments("download_file", {
        connection: " Drive ",
        source: { fileId: " id " },
      })
    ).toEqual({ connection: "Drive", source: { fileId: "id" }, destination: { path: undefined } });
    expect(parseReferenceArguments("SearchIMessages", { query: "hi", limit: 101 })).toEqual({
      query: "hi",
      limit: 101,
    });
    expect(parseReferenceArguments("FindIMessageChats", { query: "", limit: 500 })).toMatchObject({
      limit: 500,
    });
    expect(() => parseReferenceArguments("GetCredentialProviderStatus", { extra: true })).toThrow();
  });
  test("desktop metadata is rendered without private transport fields", () => {
    expect(
      renderDesktopResult(
        "GetCredentialProviderStatus",
        {
          kind: "connected",
          connectionCount: 1,
          itemCount: 2,
          connectionsNeedingAttention: 0,
          private: "no",
        },
        {}
      )
    ).toBe(
      "Credential provider status: connected. Connections: 1. Saved item count: 2. Connections needing renewal or attention: 0. This is metadata only; credential values are never returned."
    );
    expect(
      renderDesktopResult(
        "request_cookie_origin_approval",
        {
          kind: "listed",
          items: [{ origin: "example.com", profileId: "Default", profileDisplayName: "Person 1" }],
        },
        {}
      )
    ).toBe(
      'Available Chrome cookie origins:\n- example.com — profileId: "Default" (display name: "Person 1")'
    );
    expect(
      renderDesktopResult(
        "ChatItems",
        {
          kind: "items",
          items: [],
          truncated: "count",
          nextBefore: { date: "2026-09-12T00:00:00Z", id: 42 },
        },
        { chatGuid: "iMessage;-;fixture" }
      )
    ).toContain("Pass nextBefore as before");
    expect(
      renderDesktopResult(
        "FindContacts",
        { kind: "find-contacts", contacts: [], truncated: "bytes" },
        {}
      )
    ).toContain("Use a fuller name.");
  });
  test("transfer receipts contain source metadata, not bytes", () => {
    expect(
      describeUploadFileOutcome(
        {
          kind: "uploaded",
          name: "report.txt",
          id: "file-1",
          sizeBytes: 12,
          mimeType: "text/plain",
          webUrl: "https://example.com/file-1",
        },
        { sourcePath: "/box/report.txt", connection: "Drive" }
      )
    ).toBe(
      'Uploaded /box/report.txt to Drive as "report.txt" (12 bytes, text/plain).\nid: file-1\nlink: https://example.com/file-1\nShare the link with the user if they need it; the file\'s bytes were sent directly and are not in this conversation.'
    );
    expect(
      describeDownloadFileOutcome(
        { kind: "unknown_connection", available: ["Drive"] },
        { source: { fileId: "x" }, connection: "Missing" }
      )
    ).toBe('"Missing" is not a connection that can serve files. Use one of: Drive.');
  });
  test("delivery and subagent acknowledgements use reference phrasing", () => {
    expect(renderControlResult("SendToUser", { sent: true, message_address: "t2s1" }, {})).toBe(
      "Message sent to user. (id: t2s1)"
    );
    expect(
      renderControlResult(
        "ReactToMessage",
        { removed: true },
        { emoji: " 👍 ", message_address: "t2u" }
      )
    ).toBe("Reacted 👍 on t2u. (Reactions toggle: react the same emoji again to take it back.)");
    expect(renderControlResult("update_state", {target:"routine",name:"Daily",folder:"daily",schedule:"0 8 * * *",enabled:true}, {action:"create"})).toBe('Saved routine "Daily" (folder daily) — Every day at 8:00 AM.');
    expect(renderControlResult("WakeParent", { woken: true }, {})).toBe(
      "The parent was awakened and this automation turn has ended."
    );
    expect(renderControlResult("CheckSubagent", { subagents: [] }, {})).toBe(
      "No background subagents are running right now."
    );
    expect(
      renderControlResult(
        "DraftExternalMessage",
        { sent: true, message_id: "draft-1" },
        { platform: "email", to: ["a@example.com"] }
      )
    ).toBe(
      "Draft email to a@example.com is now an editable card in the chat (id: draft-1). Nothing has been sent; the user reviews, may edit, and sends or discards it from the card."
    );
  });
  test("plugin status formatting retains account routing and hides auth URLs", () => {
    const connections = [
      {
        server_id: "mcp-example",
        name: "Example",
        status: "ready",
        account_label: "work",
        transport: "http",
        toolCount: 3,
        pluginKey: "example",
        customInstructions: "",
      },
    ];
    expect(renderControlResult("GetMcpServerStatus", { connections }, {})).toBe(
      '1 installed MCP server(s):\n- mcp-example: Example [ready] · account="work" · transport=http · tools=3 · plugin=example (remove via UninstallPlugin — removes the whole plugin)'
    );
    expect(
      renderControlResult(
        "AuthenticateMcpServer",
        {
          completed: true,
          actionResult: { status: "needs_auth", authorizationUrl: "private-token" },
          connections,
        },
        { server_id: "mcp-example" }
      )
    ).not.toContain("private-token");
    expect(
      renderControlResult(
        "InstallPlugin",
        { status: "accepted", completed: false },
        { plugin_id: "example" }
      )
    ).toContain("operation result is unavailable");
    expect(
      renderControlResult(
        "RestartMcpServers",
        {
          completed: true,
          actionResult: { servers: [{ connectionId: "a", error: "offline" }] },
          connections,
        },
        {}
      )
    ).toContain("1 MCP server(s) failed to restart");
  });
  test("plugin search ranks individual tokens across names, skills and descriptions", () => {
    const rows = [
      { name: "z", displayName: "Z", category: "other", description: "word documents", skills: [] },
      { name: "word", displayName: "Word", category: "other", description: "", skills: [] },
    ];
    expect(rankPluginsLexically(rows, "write word documents").map((r: any) => r.name)).toEqual([
      "word",
      "z",
    ]);
  });
  test("remap results do not return submitted values and distinguish an absent hold", () => {
    expect(buildUserFormRemapReceipt({ kind: "no_hold" })).toStartWith(
      "Nothing to remap: the host holds no submitted values for this agent."
    );
    const result = buildUserFormRemapReceipt({
      kind: "remapped",
      outcomes: [{ id: "email", filled: true }],
      notRemappedFieldIds: ["name"],
    });
    expect(result).toContain("- email: filled into the page with the value the user submitted");
    expect(result).toContain("- name: not remapped — its held value was discarded");
    expect(result).toContain("one remap per form");
  });
  test("held clicks reject unsupported combinations and retain the captured duration range", () => {
    const parse = Schema.decodeUnknownSync(ComputerUseInput);
    expect(parse({ action: "click", x: 1, y: 2, holdDurationMs: 30_000 })).toMatchObject({
      holdDurationMs: 30_000,
    });
    for (const input of [
      { action: "click", x: 1, y: 2, holdDurationMs: 30_001 },
      { action: "click", x: 1, y: 2, holdDurationMs: 5, count: 2 },
      { action: "type", text: "a", holdDurationMs: 5 },
    ])
      expect(() => parse(input)).toThrow();
  });
});
