import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { Database } from "bun:sqlite";
import { ChromeCookies, decryptChromeCookie } from "../../src/main/host/chrome-cookies";
import { MacMessages } from "../../src/main/host/messages";
import { validateMessageSend } from "@openteam/contracts/messages-send";
import { nativeCommand } from "../../src/main/host/native-command";
import { HostCapabilities } from "../../src/main/host/capabilities";

test("Chrome import decrypts only requested profile/host pairs, verifies v24 domain hash, and preserves cookie metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-chrome-test-"));
  const password = "synthetic-keychain-password";
  const encrypt = (domain: string, value: string) => {
    const cipher = createCipheriv(
      "aes-128-cbc",
      pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"),
      Buffer.alloc(16, 32)
    );
    return Buffer.concat([
      Buffer.from("v10"),
      cipher.update(
        Buffer.concat([createHash("sha256").update(domain).digest(), Buffer.from(value)])
      ),
      cipher.final(),
    ]);
  };
  try {
    await mkdir(join(root, "Default"));
    await writeFile(
      join(root, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Work" } } } })
    );
    const db = new Database(join(root, "Default", "Cookies"));
    db.exec(
      "CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES ('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,has_expires INTEGER)"
    );
    for (const domain of [".example.test", ".other.test"])
      db.query("INSERT INTO cookies VALUES (?,?,?,?,'/',0,1,1,1,0)").run(
        domain,
        "session",
        "",
        encrypt(domain, `private-${domain}`)
      );
    expect(db.query("SELECT host_key FROM cookies").all()).toHaveLength(2);
    db.close(true);
    let decisions = 0;
    let selectedItems: string[] | undefined;
    let reads = 0;
    const cookies = new ChromeCookies(
      async (file, args, signal) => {
        if (file.endsWith("security")) {
          reads++;
          return password + "\n";
        }
        const fixture = new Database(args.at(-2)!, { readonly: true });
        try {
          return JSON.stringify(fixture.query(args.at(-1)!).all());
        } finally {
          fixture.close();
        }
      },
      root
    );
    expect((await cookies.collect("bot-a", [])).items).toHaveLength(2);
    expect(reads).toBe(0);
    await expect(
      cookies.collect("bot-a", [{ origin: ".example.test", profileId: "Work" }])
    ).rejects.toThrow();
    expect(reads).toBe(0);
    const result = await cookies.collect("bot-a", [
      { origin: ".example.test", profileId: "Default" },
    ]);
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies![0]!.value).toBe("private-.example.test");
    expect(decisions).toBe(0);
    await cookies.collect("bot-a", [".example.test"]);
    expect(decisions).toBe(0);
    await cookies.collect("bot-b", [".example.test"]);
    expect(decisions).toBe(0);
    await cookies.collect("bot-a", [".example.test"]);
    expect(decisions).toBe(0);
    selectedItems = [JSON.stringify(["Default", ".example.test"])];
    const scoped = await cookies.collect("bot-a", [".example.test", ".other.test"]);
    expect(scoped.grants?.map((item) => item.origin)).toEqual([".example.test", ".other.test"]);
    expect(scoped.cookies?.map((item) => item.domain)).toEqual([".example.test", ".other.test"]);

    expect(() =>
      decryptChromeCookie(
        encrypt(".other.test", "x").toString("hex"),
        password,
        ".example.test",
        24
      )
    ).toThrow("host verification");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Messages sends validate recipient and pass body as argv, never executable script text", async () => {
  for (const input of [
    { text: "hello", to: "Alice" },
    { text: "hello", to: "+15555550100", chatId: "iMessage;+;group" },
    { text: "hello", chatId: "arbitrary" },
  ])
    expect(() => validateMessageSend(input)).toThrow();
  const body = 'hello " & do shell script "do-not-run"';
  let calls = 0;
  const messages = new MacMessages(async (file, args) => {
    if (file.endsWith("sqlite3")) return "[]";
    calls++;
    expect(file).toBe("/usr/bin/osascript");
    expect(args[1]).not.toContain(body);
    expect(args[2]).toBe(body);
    return "submitted";
  });
  expect(await messages.execute("SendIMessage", { text: body, to: "+15555550100" })).toMatchObject({
    kind: "send",
    text: body,
    to: "+15555550100",
    verified: false,
  });
  expect(calls).toBe(1);
});

test("the cookie tool dispatches by its current name with parsed origins; the old name is unknown", async () => {
  const requests: unknown[] = [];
  const cookies = { collect: async (_botId: string, origins: unknown) => (requests.push(origins), { kind: "listed", items: [] }) };
  const host = new HostCapabilities(undefined, cookies as unknown as ChromeCookies, "darwin");
  expect(await host.handle({ tool: "RequestCookieOriginApproval", botId: "bot", arguments: { origins: [{ origin: "example.com", profileId: "Default" }] } })).toEqual({ kind: "listed", items: [] });
  expect(requests).toEqual([[{ origin: "example.com", profileId: "Default" }]]);
  await expect(host.handle({ tool: "RequestCookieOriginApproval", botId: "bot", arguments: { origins: "example.com" } })).rejects.toThrow();
  await expect(host.handle({ tool: "import_chrome_cookies", botId: "bot", arguments: {} })).rejects.toThrow("Unknown desktop capability");
  expect(requests).toHaveLength(1);
});

test("Messages requests run only while this Mac's own setting allows them", async () => {
  let enabled = false;
  let reads = 0;
  const messages = { execute: async () => { reads++; return { kind: "items", items: [] }; }, people: async () => ({}) };
  const host = new HostCapabilities(messages as unknown as MacMessages, undefined, "darwin", undefined, { enabled: async () => enabled });
  const request = { tool: "ChatItems", botId: "bot-1", arguments: { chatGuid: "any;-;+15555550100" } };
  await expect(host.handle(request)).rejects.toThrow("Messages is turned off in the user's settings on this Mac");
  expect(reads).toBe(0);
  enabled = true;
  await expect(host.handle(request)).resolves.toMatchObject({ kind: "items" });
  expect(reads).toBe(1);
});

test("a missing macOS grant names itself and opens the permissions dialog instead of failing generically", async () => {
  let permissions = { fullDiskAccess: false, automation: "unknown", contacts: "notAsked" } as Record<string, unknown>;
  let prompts = 0;
  const access = { permissions: async () => permissions, noteAutomation: () => {} };
  const messages = { execute: async () => ({ kind: "items", items: [] }), people: async () => ({}) };
  const host = new HostCapabilities(messages as unknown as MacMessages, undefined, "darwin", undefined, {
    enabled: async () => true,
    access: access as never,
    onGrantMissing: () => { prompts++; },
  });
  await expect(host.handle({ tool: "ChatItems", botId: "b", arguments: {} })).rejects.toThrow("has not granted OpenTeam Full Disk Access");
  await expect(host.handle({ tool: "FindContacts", botId: "b", arguments: { query: "Alex" } })).rejects.toThrow("hasn't been asked for Contacts access yet");
  expect(prompts).toBe(2);
  permissions = { fullDiskAccess: true, automation: "notAsked", contacts: "notAsked" };
  // Checking permissions never needs a grant, and reports what Settings shows.
  await expect(host.handle({ tool: "CheckIMessagePermissions", botId: "b", arguments: {} })).resolves.toEqual({
    kind: "check-permissions", fullDiskAccess: true, automation: "notAsked", contacts: "denied",
  });
  await expect(host.handle({ tool: "ChatItems", botId: "b", arguments: {} })).resolves.toMatchObject({ kind: "items" });
  permissions = { fullDiskAccess: true, automation: "denied", contacts: "granted" };
  await expect(host.handle({ tool: "SendIMessage", botId: "b", callId: "c", arguments: { text: "hi", to: "+15555550100" } })).rejects.toThrow("has not granted OpenTeam Automation for Messages");
  expect(prompts).toBe(3);
});
