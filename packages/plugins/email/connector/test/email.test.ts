import { expect, spyOn, test } from "bun:test";
import nodemailer from "nodemailer";
import PostalMime from "postal-mime";
import { senderAuthenticated } from "../authentication";
import { Mailbox, OWNER_SENDER } from "../mailbox";
import { tools } from "../server";
import { loadSettings, parseEndpoint, type MailSettings } from "../settings";

const settings = (address: string, smtp = "smtp://127.0.0.1:1", owners: string[] = []): MailSettings => ({
  address, username: address, password: "x", owners, detectedBy: "test",
  imap: parseEndpoint("imap://127.0.0.1:1", "imap"), smtp: parseEndpoint(smtp, "smtp"),
});
const byName = Object.fromEntries(tools("account-1").map((tool) => [tool.name, tool]));

test("Bots get four read-only tools; sending and polling stay host-only review paths", () => {
  const reads = ["ListEmailInboxes", "SearchEmailThreads", "ReadEmailThread", "ReadEmailAttachment"];
  expect(tools("account-1").filter((tool) => !tool._meta?.["openteam/hostOnly"]).map((tool) => tool.name)).toEqual(reads);
  for (const name of reads) expect(byName[name]!.annotations.readOnlyHint).toBe(true);
  expect(byName.SearchEmailThreads!.inputSchema.properties.mode.enum).toEqual(["hybrid", "keyword", "semantic"]);
  expect(byName.ListEmailInboxes!.description).toContain("(providerIdentifier account-1)");
  for (const name of ["send_reviewed_email", "poll_new_mail"]) expect(byName[name]!._meta).toEqual({ "openteam/hostOnly": true });
});

test("SMTP reviewed forwards show their source and carry reviewed files without reply threading", async () => {
  const config = settings("me@example.com", "smtp://smtp.gmail.com:25");
  const mailbox = new Mailbox(config);
  const source = { subject: "Invoice", from: { name: "Ann", address: "ann@example.com" }, to: [{ address: "me@example.com" }],
    text: "Original invoice contents.", html: "<p>Original invoice contents.</p>", date: "2026-11-12", messageId: "<original@example.com>" };
  Object.assign(mailbox, { session: async (work: (client: unknown) => Promise<unknown>) => work({}), load: async () => ({ parsed: source }) });
  const sent: Buffer[] = [];
  const transport = spyOn(nodemailer, "createTransport").mockImplementation(() => ({
    sendMail: async ({ raw }: { raw: Buffer }) => { sent.push(raw); return { accepted: ["bob@example.com"], rejected: [] }; },
    close() {},
  }) as never);
  try {
    const context = { mailbox, settings: config, accountId: "account" };
    const draft = { from: config.address, to: ["bob@example.com"], subject: "Fwd: Invoice", body: "Please review.", html: "<p>Please review.</p>",
      forwardMessageId: "INBOX:1", attachments: [{ filename: "notes.txt", mimeType: "text/plain", content: Buffer.from("Reviewed bytes.").toString("base64") }] };
    const reviewed = byName.send_reviewed_email!;
    expect(await reviewed.run(context, { action: "verify", draft })).toMatchObject({ forwarding: "“Invoice” from Ann <ann@example.com>" });
    await reviewed.run(context, { action: "send", draft });
    const parsed = await PostalMime.parse(sent[0]!);
    expect(parsed.subject).toBe("Fwd: Invoice");
    expect(parsed.inReplyTo).toBeUndefined();
    expect(parsed.text).toContain("From: Ann <ann@example.com>");
    expect(parsed.text).toContain("Original invoice contents.");
    expect(parsed.html).toContain("<blockquote><p>Original invoice contents.</p></blockquote>");
    expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer).toString()).toBe("Reviewed bytes.");
    Object.assign(mailbox, { load: async () => { throw new Error("Original message not found"); } });
    await expect(reviewed.run(context, { action: "send", draft })).rejects.toThrow("not found");
    expect(sent).toHaveLength(1);
  } finally { transport.mockRestore(); }
});

test("ReadEmailThread lists Reply-To after Cc and marks the user's own verified address as the owner", () => {
  const mailbox = new Mailbox(settings("bot@example.test", undefined, ["me@home.test"]), "/tmp") as any;
  const lines = mailbox.renderMessage(
    { ref: { key: "INBOX", uid: 7 }, message: { envelope: {}, internalDate: new Date("2026-10-20T10:00:00Z") } },
    { headers: [{ key: "authentication-results", value: "mx.example.test; dmarc=pass header.from=home.test" }], to: [{ address: "bot@example.test", name: "" }],
      attachments: [], text: "Hello", from: { address: "me@home.test", name: "Me" }, replyTo: [{ address: "assistant@home.test", name: "Assistant" }],
      cc: [{ address: "ann@example.test", name: "" }], subject: "Plan" },
    1, 4000) as string[];
  expect(lines.slice(1, 7)).toEqual(["From: Me <me@home.test>", OWNER_SENDER, "To: bot@example.test", "Cc: ann@example.test", "Reply-To: Assistant <assistant@home.test>", "Subject: Plan"]);
});

test("the user's own addresses are optional, lowercased and checked", async () => {
  const offline = { mx: async () => [] as string[], ispdb: async () => null };
  const base = { EMAIL_ADDRESS: "bot@gmail.com", EMAIL_PASSWORD: "x" };
  expect((await loadSettings(base, offline)).owners).toEqual([]);
  expect((await loadSettings({ ...base, OWNER_ADDRESSES: "none" }, offline)).owners).toEqual([]);
  expect((await loadSettings({ ...base, OWNER_ADDRESSES: " Me@Home.example, me@work.example;me@home.example " }, offline)).owners)
    .toEqual(["me@home.example", "me@work.example"]);
  await expect(loadSettings({ ...base, OWNER_ADDRESSES: "Me <me@home.example>" }, offline)).rejects.toThrow(
    "Your own addresses must be plain email addresses separated by commas");
});

test("sender authentication trusts only the receiving server's topmost verdict: DMARC, else aligned DKIM, never SPF alone", () => {
  const gmail = (results: string) =>
    `Delivered-To: bot@gmail.com\r\nAuthentication-Results: mx.google.com;\r\n       ${results}\r\nAuthentication-Results: forged.example; dmarc=pass header.from=evil.example\r\nFrom: Alice <alice@partner.com>\r\n`;
  const alice = (results: string) => senderAuthenticated(gmail(results), "alice@partner.com");
  expect(alice("dkim=pass header.i=@partner.com header.s=s1;\r\n       spf=pass smtp.mailfrom=alice@partner.com;\r\n       dmarc=pass (p=NONE) header.from=partner.com")).toBe(true);
  expect(alice("dkim=pass header.i=@partner.com;\r\n       dmarc=fail (p=REJECT) header.from=partner.com")).toBe(false);
  expect(alice("dkim=pass header.d=mail.partner.com; dmarc=none header.from=partner.com")).toBe(true);
  expect(alice("dkim=pass header.d=bulk-sender.example; dmarc=none")).toBe(false);
  expect(alice("spf=pass smtp.mailfrom=alice@partner.com")).toBe(false);
  const forged = "Authentication-Results: mx.google.com; spf=softfail; dmarc=fail header.from=bank.example\r\nAuthentication-Results: attacker.example; dmarc=pass header.from=bank.example\r\n";
  expect(senderAuthenticated(forged, "support@bank.example")).toBe(false);
  expect(senderAuthenticated("From: x@y.example\r\n", "x@y.example")).toBe(false);
});
