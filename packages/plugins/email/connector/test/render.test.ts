import { describe, expect, test } from "bun:test";
import { EXTERNAL_SENDER, Mailbox, OWNER_SENDER } from "../mailbox";
import { parseEndpoint, type MailSettings } from "../settings";

const settings: MailSettings = {
  address: "bot@example.test",
  username: "bot@example.test",
  password: "x",
  imap: parseEndpoint("imap://127.0.0.1:1", "imap"),
  smtp: parseEndpoint("smtp://127.0.0.1:1", "smtp"),
  detectedBy: "test",
  owners: ["me@home.test"],
};
const render = (parsed: Record<string, unknown>, bodyMaxChars = 4000) =>
  (new Mailbox(settings, "/tmp") as any).renderMessage(
    { ref: { key: "INBOX", uid: 7 }, message: { envelope: {}, internalDate: new Date("2026-10-20T10:00:00Z") } },
    { headers: [], to: [{ address: "bot@example.test", name: "" }], attachments: [], text: "Hello", ...parsed },
    1,
    bodyMaxChars
  ) as string[];
const dmarc = (verdict: string) => [{ key: "authentication-results", value: `mx.example.test; dmarc=${verdict} header.from=home.test` }];

describe("ReadEmailThread message lines", () => {
  test("Reply-To follows Cc, and the user's own verified address reads as the owner", () => {
    expect(render({ from: { address: "me@home.test", name: "Me" }, replyTo: [{ address: "assistant@home.test", name: "Assistant" }], cc: [{ address: "ann@example.test", name: "" }], subject: "Plan", headers: dmarc("pass") }).slice(1, 7)).toEqual([
      "From: Me <me@home.test>",
      OWNER_SENDER,
      "To: bot@example.test",
      "Cc: ann@example.test",
      "Reply-To: Assistant <assistant@home.test>",
      "Subject: Plan",
    ]);
  });

  test("an unverified own address, or any other sender, is external", () => {
    expect(render({ from: { address: "me@home.test", name: "" }, headers: dmarc("fail") })[2]).toBe(EXTERNAL_SENDER);
    expect(render({ from: { address: "ann@example.test", name: "" }, headers: dmarc("pass") })[2]).toBe(EXTERNAL_SENDER);
  });

  test("missing sender and subject, an unopenable attachment and a cut body read like the reference", () => {
    const lines = render({
      to: [],
      subject: "  ",
      text: "A long body that goes on",
      attachments: [
        { filename: "scan.pdf", mimeType: "application/pdf", disposition: "attachment", content: new Uint8Array(25 * 1024 * 1024 + 1) },
        { filename: "big.csv", mimeType: "text/csv", disposition: "attachment", content: new Uint8Array(25 * 1024 * 1024 + 1) },
      ],
    }, 6);
    expect(lines).toEqual([
      "--- 1. received 2026-10-20T10:00:00Z · message_id INBOX:7",
      "From: unknown sender",
      EXTERNAL_SENDER,
      "Subject: (no subject)",
      "delivery: delivered · 2 attachments",
      "- attachment_id INBOX:7:0: scan.pdf (application/pdf, 25.0 MB). Skipped: too large, cannot be opened",
      "- attachment_id INBOX:7:1: big.csv (text/csv, 25.0 MB). Open with ReadEmailAttachment",
      "",
      "A long\n[body truncated; raise body_max_chars to read more]",
    ]);
  });
});
