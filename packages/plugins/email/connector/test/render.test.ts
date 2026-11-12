import { describe, expect, test } from "bun:test";
import { Mailbox, OWNER_SENDER } from "../mailbox";
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

});
