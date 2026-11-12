import { describe, expect, test } from "bun:test";
import { senderAuthenticated } from "../authentication";
import { loadSettings } from "../settings";

const offline = { mx: async () => [] as string[], ispdb: async () => null };

describe("mail server settings", () => {
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
