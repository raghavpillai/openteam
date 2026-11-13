import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ImapFlow } from "imapflow";
import nodemailer, { type SendMailOptions } from "nodemailer";
import { EXTERNAL_SENDER, Mailbox } from "../mailbox";
import { tools } from "../server";
import { parseEndpoint, type MailSettings } from "../settings";

// Run with a GreenMail server (auth disabled), for example:
// docker run -p 3025:3025 -p 3143:3143 -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' greenmail/standalone:2.1.3
// OPENTEAM_TEST_GREENMAIL=127.0.0.1 bun test email/connector/test/greenmail.test.ts
const host = process.env.OPENTEAM_TEST_GREENMAIL;
const suite = host ? describe : describe.skip;

const settingsFor = (address: string): MailSettings => ({
  address, username: address, password: "test", detectedBy: "test", owners: [],
  imap: parseEndpoint(`imap://${host}:3143`, "imap"), smtp: parseEndpoint(`smtp://${host}:3025`, "smtp"),
});
const deliver = async (message: SendMailOptions) => {
  const transport = nodemailer.createTransport({ host, port: 3025, secure: false, ignoreTLS: true });
  try { return await transport.sendMail(message); } finally { transport.close(); }
};
const imap = async <T>(address: string, run: (client: ImapFlow) => Promise<T>) => {
  const client = new ImapFlow({ host: host!, port: 3143, secure: false, auth: { user: address, pass: "test" }, logger: false });
  await client.connect();
  try { return await run(client); } finally { await client.logout(); }
};
const pdf = Buffer.from("%PDF-1.4\n% test\n");

suite("Email connector against an IMAP/SMTP server", () => {
  test("tools search, read threads and attachments, poll new mail, and send reviewed replies", async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const bot = `bot-${id}@example.test`;
    const alice = `alice-${id}@partner.test`;
    const folder = await mkdtemp(join(tmpdir(), "email-attachments-"));
    const mailbox = new Mailbox(settingsFor(bot), folder);
    const settings = settingsFor(bot);
    const byName = Object.fromEntries(tools("account-1").map((tool) => [tool.name, tool]));
    const call = (name: string, args: Record<string, unknown> = {}) => byName[name]!.run({ mailbox, settings, accountId: "account-1" }, args);
    await imap(bot, (client) => client.mailboxCreate("Sent").catch(() => undefined));

    expect(await call("ListEmailInboxes")).toBe(`Your email address:\n- ${bot}`);
    const baseline = await mailbox.poll(null);
    expect(baseline.events).toEqual([]);

    await deliver({
      from: `Alice Partner <${alice}>`,
      to: bot,
      subject: `Q3 numbers ${id}`,
      text: "Hi! Attached are the Q3 numbers. What was the total for September?",
      headers: { "Authentication-Results": "mx.test; dkim=pass header.d=partner.test; dmarc=pass header.from=partner.test" },
      attachments: [
        { filename: "q3.csv", content: "month,total\nJuly,1200\nAugust,1450\nSeptember,1630\n", contentType: "text/csv" },
        { filename: "q3.pdf", content: pdf, contentType: "application/pdf" },
      ],
    });
    await deliver({ from: bot, to: bot, subject: "Note to self", text: "loop guard" });
    const uid = baseline.cursor.uidNext;
    const message = `INBOX:${uid}`;

    // The routine wake: headers only, with the ids ReadEmailThread needs.
    const polled = await mailbox.poll(baseline.cursor);
    expect(polled.events).toHaveLength(1);
    expect(polled.events[0]).toMatchObject({ channel: bot, actor: alice, authenticatedUser: true });
    const wake = polled.events[0]!.text.split("\n");
    expect(wake[0]).toBe(`New email in ${bot}:`);
    expect(wake[1]).toMatch(new RegExp(`^received \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ · message_id ${message} · thread_id ${message}$`));
    expect(wake).toContain(EXTERNAL_SENDER);
    expect(wake).toContain("delivery: delivered · 2 attachments");
    expect(wake.at(-1)).toBe("Read the conversation with ReadEmailThread and its thread_id.");
    expect(polled.events[0]!.text).not.toContain("What was the total");
    expect((await mailbox.poll(polled.cursor)).events).toEqual([]);

    // SearchEmailThreads returns plain text.
    const search = (await call("SearchEmailThreads", { query: `Q3 numbers ${id}`, mode: "keyword" })) as string;
    expect(search.split("\n")).toEqual([
      `1 thread matches "Q3 numbers ${id}":`,
      `1. Q3 numbers ${id}`,
      expect.stringMatching(new RegExp(`^   thread_id: ${message} · 1 message · last \\d{4}-.+Z$`)),
      `   participants: Alice Partner <${alice}>, ${bot}`,
      expect.stringMatching(new RegExp(`^   - received .+Z from Alice Partner <${alice}> \\(message_id ${message}\\)$`)),
      "     Hi! Attached are the Q3 numbers. What was the total for September?",
      "Read a conversation with ReadEmailThread and its thread_id.",
    ]);
    for (const mode of ["hybrid", "semantic"]) expect(await call("SearchEmailThreads", { query: `September total ${id}`, mode })).toContain(`thread_id: ${message}`);
    expect(await call("SearchEmailThreads", { query: id, inbox_email: bot.toUpperCase(), from_address: alice, after: "2000-01-01T00:00:00Z", before: "2100-01-01T00:00:00Z", limit: 25 }))
      .toContain(`thread_id: ${message}`);
    const none = (query: string) => `No email threads match "${query}". Try different words, a wider time range, or mode "keyword" for an exact address or phrase.`;
    expect(await call("SearchEmailThreads", { query: id, after: "2100-01-01T00:00:00Z" })).toBe(none(id));
    expect(await call("SearchEmailThreads", { query: `nothing-${id}`, mode: "keyword" })).toBe(none(`nothing-${id}`));
    // An empty bound counts as omitted; bounds must be ordered and readable.
    expect(await call("SearchEmailThreads", { query: id, inbox_email: " ", from_address: "", after: "", before: " " })).toContain(`thread_id: ${message}`);
    await expect(call("SearchEmailThreads", { query: id, after: "2026-10-02T00:00:00Z", before: "2026-10-01T00:00:00Z" })).rejects.toThrow("after must be earlier than before.");
    await expect(call("SearchEmailThreads", { query: id, before: "next week" })).rejects.toThrow('before must be an ISO 8601 timestamp such as 2026-09-01T00:00:00Z; got "next week".');
    await expect(call("SearchEmailThreads", { query: id, inbox_email: alice })).rejects.toThrow("must be one of your own addresses");

    // ReadEmailThread and ReadEmailAttachment.
    const thread = (await call("ReadEmailThread", { thread_id: message })) as string;
    expect(thread.split("\n")).toEqual([
      `Thread ${message}: 1 message.`,
      expect.stringMatching(new RegExp(`^--- 1\\. received .+Z · message_id ${message}$`)),
      `From: Alice Partner <${alice}>`,
      EXTERNAL_SENDER,
      `To: ${bot}`,
      `Subject: Q3 numbers ${id}`,
      "delivery: delivered · 2 attachments",
      `- attachment_id ${message}:0: q3.csv (text/csv, 49 B). Open with ReadEmailAttachment`,
      `- attachment_id ${message}:1: q3.pdf (application/pdf, 16 B). Open with ReadEmailAttachment`,
      "",
      "Hi! Attached are the Q3 numbers. What was the total for September?",
    ]);
    expect(await call("ReadEmailThread", { thread_id: message, body_max_chars: 10 })).toContain("Hi! Attach\n[body truncated; raise body_max_chars to read more]");
    await expect(call("ReadEmailThread", { thread_id: "INBOX:999999" })).rejects.toThrow("Search first; do not guess thread ids");
    expect(await call("ReadEmailAttachment", { attachment_id: `${message}:0` }))
      .toBe(`Attachment "q3.csv" (text/csv, 49 B), attachment_id ${message}:0:\n\nmonth,total\nJuly,1200\nAugust,1450\nSeptember,1630`);
    const saved = (await call("ReadEmailAttachment", { attachment_id: `${message}:1` })) as string;
    const path = join(folder, bot, `INBOX-${uid}-1-q3.pdf`);
    expect(saved).toBe(`Attachment "q3.pdf" (application/pdf, 16 B), attachment_id ${message}:1, saved to ${path}. Read it there with the Read tool or Shell, or attach it to a message by that path.`);
    expect(await readFile(path)).toEqual(pdf);
    await expect(call("ReadEmailAttachment", { attachment_id: `${message}:5` })).rejects.toThrow("No attachment");

    // A reviewed reply joins the same thread, filed in Sent.
    const draft = { from: bot, to: [alice], subject: `Re: Q3 numbers ${id}`, body: "September was 1630.", replyToMessageId: message };
    expect(await call("send_reviewed_email", { action: "verify", draft })).toEqual({ identity: bot, sendingAddresses: [bot], thread: `message ${message} in ${bot}` });
    await expect(call("send_reviewed_email", { action: "verify", draft: { ...draft, from: alice } })).rejects.toThrow(`but this account sends as ${bot}`);
    await expect(call("send_reviewed_email", { action: "verify", draft: { ...draft, replyToMessageId: "INBOX:999999" } })).rejects.toThrow("was not found");
    expect(await call("send_reviewed_email", { action: "send", draft })).toMatchObject({ accepted: [alice], savedToSent: "Sent" });
    const conversation = (await call("ReadEmailThread", { thread_id: message })) as string;
    expect(conversation.split("\n")[0]).toBe(`Thread ${message}: 2 messages.`);
    expect(conversation).toMatch(/--- 2\. sent .+Z · message_id SENT:\d+\nFrom: bot-/);
    expect(conversation).toContain("delivery: sent");
    expect(conversation.split("\n").filter((line) => line === EXTERNAL_SENDER)).toHaveLength(1);
    expect(await call("ReadEmailThread", { thread_id: message, max_messages: 1 })).toMatch(/^Thread INBOX:\d+: 1 message shown, 1 older not shown \(raise max_messages to include them\)\.\n--- 2\. sent/);
    const delivered = await imap(alice, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try { return await client.fetchOne("*", { envelope: true, headers: ["in-reply-to"] }); } finally { lock.release(); }
    });
    expect(delivered && delivered.envelope?.subject).toBe(`Re: Q3 numbers ${id}`);
    expect(delivered && delivered.headers?.toString()).toContain("In-Reply-To: <");
  }, 90_000);

  test("a packaged server that cannot sign in never reveals the password", async () => {
    const bot = `bot-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const env = {
      EMAIL_ADDRESS: bot,
      EMAIL_PASSWORD: "s3cret-app-password",
      EMAIL_USERNAME: "auto",
      IMAP_SERVER: `imap://${host}:3143`,
      SMTP_SERVER: `smtp://${host}:3025`,
      OPENTEAM_PLUGIN_ACCOUNT_ID: "11111111-2222-3333-4444-555555555555",
    };
    const unreachable = new Client({ name: "test", version: "1.0.0" });
    await unreachable.connect(new StdioClientTransport({ command: "bun", args: [`${import.meta.dir}/../server.ts`], env: { PATH: process.env.PATH!, ...env, IMAP_SERVER: `imap://${host}:9` } }));
    try {
      const error = await unreachable.listTools().then(() => null, (failure: Error) => failure.message);
      expect(error).toContain(`Could not sign in to ${host}`);
      expect(error).not.toContain("s3cret-app-password");
    } finally {
      await unreachable.close();
    }
  }, 60_000);
});
