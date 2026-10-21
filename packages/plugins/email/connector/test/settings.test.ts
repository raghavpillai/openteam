import { describe, expect, test } from "bun:test";
import { senderAuthenticated } from "../authentication";
import { parseAttachmentId, parseMessageRef } from "../mailbox";
import { detectServers, loadSettings, parseEndpoint, parseIspdb } from "../settings";

const offline = { mx: async () => [] as string[], ispdb: async () => null };

describe("mail server settings", () => {
  test("endpoints follow the port convention unless a scheme says otherwise", () => {
    expect(parseEndpoint("imap.gmail.com", "imap")).toEqual({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      starttls: false,
    });
    expect(parseEndpoint("mail.example.com:143", "imap")).toEqual({
      host: "mail.example.com",
      port: 143,
      secure: false,
      starttls: true,
    });
    expect(parseEndpoint("smtp.example.com:587", "smtp")).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      starttls: true,
    });
    expect(parseEndpoint("smtp.example.com", "smtp")).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      starttls: false,
    });
    expect(parseEndpoint("imap://127.0.0.1:1143", "imap")).toEqual({
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      starttls: false,
    });
    expect(parseEndpoint("smtps://[::1]:2465", "smtp")).toEqual({
      host: "::1",
      port: 2465,
      secure: true,
      starttls: false,
    });
    expect(() => parseEndpoint("smtp://host", "imap")).toThrow("imap:// or imaps://");
    expect(() => parseEndpoint("host:99999", "imap")).toThrow("port");
    expect(() => parseEndpoint("bad host", "smtp")).toThrow("Invalid SMTP server");
  });

  test("detection uses the address domain, then MX hosts, then Thunderbird's database", async () => {
    expect((await detectServers("bot@gmail.com", offline)).servers.imap).toBe("imap.gmail.com:993");
    const workspace = await detectServers("bot@raghav.sh", {
      ...offline,
      mx: async () => ["smtp.google.com"],
    });
    expect(workspace).toEqual({
      servers: { imap: "imap.gmail.com:993", smtp: "smtp.gmail.com:465" },
      detectedBy: "Gmail / Google Workspace (mail for raghav.sh)",
    });
    expect(
      (
        await detectServers("me@example.org", {
          ...offline,
          mx: async () => ["mx01.mail.icloud.com"],
        })
      ).servers.smtp
    ).toBe("smtp.mail.me.com:587");
    expect(
      await detectServers("me@small.example", {
        mx: async () => ["mx.small.example"],
        ispdb: async () => ({ imap: "imap.small.example:993", smtp: "smtp.small.example:465" }),
      })
    ).toEqual({
      servers: { imap: "imap.small.example:993", smtp: "smtp.small.example:465" },
      detectedBy: "Thunderbird provider database",
    });
    await expect(detectServers("me@unknown.example", offline)).rejects.toThrow(
      "Enter the IMAP and SMTP servers"
    );
  });

  test("providers without app-password mail access explain the alternative", async () => {
    await expect(detectServers("me@outlook.com", offline)).rejects.toThrow("only allows OAuth");
    await expect(
      detectServers("me@company.com", {
        ...offline,
        mx: async () => ["company-com.mail.protection.outlook.com"],
      })
    ).rejects.toThrow("Microsoft");
    await expect(detectServers("me@proton.me", offline)).rejects.toThrow("Proton Mail Bridge");
  });

  test("account fields default to the address and detected servers", async () => {
    const settings = await loadSettings(
      {
        EMAIL_ADDRESS: " Bot@Gmail.com ",
        EMAIL_PASSWORD: "app-password",
        EMAIL_USERNAME: "auto",
        IMAP_SERVER: "auto",
        SMTP_SERVER: "auto",
      },
      offline
    );
    expect(settings).toMatchObject({
      address: "bot@gmail.com",
      username: "bot@gmail.com",
      imap: { host: "imap.gmail.com" },
      smtp: { host: "smtp.gmail.com" },
    });
    const manual = await loadSettings(
      {
        EMAIL_ADDRESS: "me@custom.example",
        EMAIL_PASSWORD: "x",
        EMAIL_USERNAME: "me",
        IMAP_SERVER: "imap://bridge:1143",
        SMTP_SERVER: "smtp://bridge:1025",
      },
      offline
    );
    expect(manual).toMatchObject({
      username: "me",
      imap: { host: "bridge", port: 1143 },
      smtp: { host: "bridge", port: 1025 },
      detectedBy: "account settings",
    });
    await expect(
      loadSettings({ EMAIL_ADDRESS: "nope", EMAIL_PASSWORD: "x" }, offline)
    ).rejects.toThrow("full email address");
    await expect(loadSettings({ EMAIL_ADDRESS: "a@gmail.com" }, offline)).rejects.toThrow(
      "password"
    );
  });

  test("the user's own addresses are optional, lowercased and checked", async () => {
    const base = { EMAIL_ADDRESS: "bot@gmail.com", EMAIL_PASSWORD: "x" };
    expect((await loadSettings(base, offline)).owners).toEqual([]);
    expect((await loadSettings({ ...base, OWNER_ADDRESSES: "none" }, offline)).owners).toEqual([]);
    expect(
      (await loadSettings({ ...base, OWNER_ADDRESSES: " Me@Home.example, me@work.example;me@home.example " }, offline)).owners
    ).toEqual(["me@home.example", "me@work.example"]);
    await expect(loadSettings({ ...base, OWNER_ADDRESSES: "Me <me@home.example>" }, offline)).rejects.toThrow(
      "Your own addresses must be plain email addresses separated by commas"
    );
  });

  test("Thunderbird provider entries yield the first TLS servers", () => {
    const xml = `<clientConfig><emailProvider id="x"><incomingServer type="pop3"><hostname>pop.x.test</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
      <incomingServer type="imap"><hostname>imap.x.test</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
      <outgoingServer type="smtp"><hostname>smtp.x.test</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer></emailProvider></clientConfig>`;
    expect(parseIspdb(xml)).toEqual({ imap: "imap.x.test:993", smtp: "smtp.x.test:587" });
    expect(parseIspdb(xml.replace("imap.x.test", "%EMAILDOMAIN%"))).toBeNull();
    expect(parseIspdb("<clientConfig/>")).toBeNull();
  });

  test("message and attachment ids name a folder role and a UID", () => {
    expect(parseMessageRef("INBOX:42")).toEqual({ key: "INBOX", uid: 42 });
    expect(parseMessageRef("SENT:7")).toEqual({ key: "SENT", uid: 7 });
    expect(parseMessageRef("<abc@example.com>")).toEqual({ messageId: "<abc@example.com>" });
    for (const bad of ["INBOX", "INBOX:0", "[Gmail]/Sent Mail:7", "455859"])
      expect(() => parseMessageRef(bad)).toThrow("Invalid message_id");
    expect(parseAttachmentId("ALL:9:1")).toEqual({ key: "ALL", uid: 9, index: 1 });
    expect(() => parseAttachmentId("INBOX:9")).toThrow("Invalid attachment_id");
  });
});

describe("sender authentication", () => {
  const gmail = (results: string) =>
    `Delivered-To: bot@gmail.com\r\nAuthentication-Results: mx.google.com;\r\n       ${results}\r\nAuthentication-Results: forged.example; dmarc=pass header.from=evil.example\r\nFrom: Alice <alice@partner.com>\r\n`;

  test("the provider's DMARC verdict decides", () => {
    expect(
      senderAuthenticated(
        gmail(
          "dkim=pass header.i=@partner.com header.s=s1;\r\n       spf=pass smtp.mailfrom=alice@partner.com;\r\n       dmarc=pass (p=NONE) header.from=partner.com"
        ),
        "alice@partner.com"
      )
    ).toBe(true);
    expect(
      senderAuthenticated(
        gmail(
          "dkim=pass header.i=@partner.com;\r\n       dmarc=fail (p=REJECT) header.from=partner.com"
        ),
        "alice@partner.com"
      )
    ).toBe(false);
  });

  test("without DMARC, an aligned DKIM signature counts and SPF alone does not", () => {
    expect(
      senderAuthenticated(
        gmail("dkim=pass header.d=mail.partner.com; dmarc=none header.from=partner.com"),
        "alice@partner.com"
      )
    ).toBe(true);
    expect(
      senderAuthenticated(
        gmail("dkim=pass header.d=bulk-sender.example; dmarc=none"),
        "alice@partner.com"
      )
    ).toBe(false);
    expect(
      senderAuthenticated(gmail("spf=pass smtp.mailfrom=alice@partner.com"), "alice@partner.com")
    ).toBe(false);
  });

  test("only the topmost header added by the receiving server is trusted", () => {
    const forged =
      "Authentication-Results: mx.google.com; spf=softfail; dmarc=fail header.from=bank.example\r\nAuthentication-Results: attacker.example; dmarc=pass header.from=bank.example\r\n";
    expect(senderAuthenticated(forged, "support@bank.example")).toBe(false);
    expect(senderAuthenticated("From: x@y.example\r\n", "x@y.example")).toBe(false);
  });
});
