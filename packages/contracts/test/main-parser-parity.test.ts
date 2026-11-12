import { expect, test } from "bun:test";
import { normalizeMainToolArguments } from "../src/reference-main-parsers";

test("parsers keep the reference arguments OpenTeam supports", () => {
  expect(normalizeMainToolArguments("ReactToMessage", { message_address: "t3u", emoji: "👍", end_turn: true })).toEqual({ message_address: "t3u", emoji: "👍", end_turn: true });
  const handoff = { instruction: "Sign in", domain: "example.com", idp_domain: "accounts.example.com", url: "https://app.example.com/login" };
  expect(normalizeMainToolArguments("request_box_help", handoff)).toEqual(handoff);
  expect(normalizeMainToolArguments("StopSubagent", { all: true })).toEqual({ all: true });
  expect(normalizeMainToolArguments("StopSubagent", { subagent_id: " sand-subagent-1 " })).toEqual({ subagent_id: "sand-subagent-1" });
  for (const invalid of [{}, { all: false }, { all: true, subagent_id: "sand-subagent-1" }])
    expect(() => normalizeMainToolArguments("StopSubagent", invalid), JSON.stringify(invalid)).toThrow("exactly one");
});
test("SendToUser refuses fields and files it would silently drop", () => {
  const refusal = (args: unknown) => {
    try { normalizeMainToolArguments("SendToUser", args); } catch (error) { return (error as Error).message; }
    throw new Error("accepted");
  };
  const others = 'Send every other file (PDF, document, spreadsheet, video) as its own SendToUser call with type:"attachment" and url (file:// or https://), one call per file.';
  expect(refusal({ type: "text", content: "hi", attachments: [{ url: "file:///workspace/a.pdf" }] })).toBe(
    `Invalid arguments:\nattachments: attachments is not a SendToUser field, so it would be silently dropped. Nothing was sent. Put images that go with your text in images on the type:text message. ${others}`
  );
  expect(refusal({ content: "hi", files: ["file:///workspace/a.pdf"] })).toStartWith("Invalid arguments:\nfiles: files is not a SendToUser field");
  // Field issues still come back beside the hint.
  expect(refusal({ type: "text", files: ["/workspace/a.pdf"] })).toBe(
    `Invalid arguments:\nfiles: files is not a SendToUser field, so it would be silently dropped. Nothing was sent. Put images that go with your text in images on the type:text message. ${others}\ncontent: content is required when type is text`
  );
  expect(normalizeMainToolArguments("SendToUser", { type: "text", content: "hi", attachments: [] })).toEqual({ type: "text", content: "hi" });
  expect(refusal({ type: "text", content: "hi", images: [{ url: "file:///workspace/report.pdf" }] })).toBe(
    `Invalid arguments:\nimages.0.url: each images url must be a picture that goes with your text, and this one is another kind of file, so nothing was sent. ${others}`
  );
  for (const url of ["file:///workspace/chart.png", "https://example.com/photo.JPG?x=1", "file:///workspace/logo.svg", "https://example.com/render"])
    expect(normalizeMainToolArguments("SendToUser", { type: "text", content: "hi", images: [{ url }] }).images).toEqual([{ url }]);
  expect(refusal({ type: "text", content: "hi", images: [{ url: "/workspace/chart.png" }] })).toBe(
    "Invalid arguments:\nimages.0.url: each images url must include a file:// or https:// scheme. For a file on your computer, put file:// before its absolute path (file:///workspace/chart.png) and send it again. Nothing was sent."
  );
  expect(refusal({ type: "attachment", url: "/workspace/report.pdf" })).toBe(
    "Invalid arguments:\nurl: url must include a file:// or https:// scheme when type is attachment. For a file on your computer, put file:// before its absolute path (file:///workspace/report.pdf) and send it again. Nothing was sent."
  );
  expect(refusal({ type: "attachment", url: "file:///workspace/a.pdf", content: "here" })).toBe(
    "Invalid arguments:\ncontent: content is only valid with type:text and cannot be sent on a type:attachment message. It would be silently dropped. Nothing was sent. Re-send as separate SendToUser calls, one per type: this field on its own properly-typed message (type:text), and any text as its own type:text message."
  );
});
