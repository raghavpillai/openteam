import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { Database } from "bun:sqlite";
import { CapabilitySettingsStore } from "../../src/main/host/capability-settings";
import { SavedCredentials } from "../../src/main/host/credentials";
import { ChromeCookies, decryptChromeCookie } from "../../src/main/host/chrome-cookies";
import { MacMessages, validateMessageSend } from "../../src/main/host/messages";
import { nativeCommand } from "../../src/main/host/native-command";

const fixtureLogin = {
  id: "fixture-login",
  title: "Example account",
  category: "LOGIN",
  updated_at: "2026-01-01",
  urls: [{ href: "https://example.test/login" }],
};
test("saved login listing exposes metadata only and respects disconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-credentials-test-"));
  try {
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    await settings.mutate(current => ({ ...current, credentialProviders: [{ account: "fixture-account", vault: "fixture-vault" }] }));
    const calls: string[][] = [];
    const provider = new SavedCredentials(settings, async (_file, args) => {
      calls.push(args);
      return JSON.stringify([fixtureLogin]);
    });
    const list = await provider.list();
    expect(list).toEqual({
      connected: true,
      unavailableConnections: [],
      credentials: [{
        credential_id: "fixture-login",
        connection_id: "1password:fixture-account:fixture-vault",
        title: "Example account",
        category: "LOGIN",
        sites: ["https://example.test"],
      }],
    });
    expect(calls).toEqual([["item", "list", "--categories=Login,Password", "--account", "fixture-account", "--vault", "fixture-vault", "--format=json"]]);
    await settings.update({ revoke: "credentials" });
    expect(await provider.list()).toEqual({ connected: false, credentials: [], unavailableConnections: [] });
    expect(calls).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    let decisions = 0;
    let selectedItems: string[] | undefined;
    let reads = 0;
    const cookies = new ChromeCookies(
      settings,
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

test("multiple vaults retain separate identities, report unavailable vaults, and disconnect individually", async()=>{
 const root=await mkdtemp(join(tmpdir(),"multiple-vault-fixture-"));
 try {
  const settings=new CapabilitySettingsStore(join(root,"settings.json"));
  await settings.mutate(current => ({ ...current, credentialProviders: [{account:"one",vault:"personal"},{account:"two",vault:"work"}] }));
  const provider=new SavedCredentials(settings,async(_file,args)=>{
   if(args.includes("two"))throw new Error("locked fixture vault");
   return JSON.stringify([fixtureLogin]);
  });
  const list=await provider.list();
  expect(list.connected).toBe(true);expect(list.credentials).toHaveLength(1);expect(list.unavailableConnections).toEqual(["1password:two:work"]);
  await settings.update({removeCredentialConnection:"1password:two:work"});
  expect((await provider.list()).unavailableConnections).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
