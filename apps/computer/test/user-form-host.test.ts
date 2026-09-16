import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatUserFormReceipt, parseUserForm } from "@openteam/contracts";
import { UserFormHost, formVaultKey, type FormBrowser } from "../src/user-form-host";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const form = { title: "Sign in", instruction: "Complete these fields", domain: "example.com", fields: [
  { id: "email", label: "Email", type: "email", required: true, target: { kind: "ref", value: "e1" } },
  { id: "password", label: "Password", type: "password", secret: false, target: { kind: "ref", value: "e2" } },
] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "user-form-host-")); roots.push(root);
  const fills: string[] = []; let fail = false; let entered = 0;
  const browser: FormBrowser = {
    canSave: async (_, field) => field.type !== "password",
    prepare: async (form) => ({ binding: { pageId: "page", domain: "example.com" }, reachable: form.fields.map((field) => field.id) }),
    fill: async (_, field) => { fills.push(field.id); return !fail; },
    submit: async () => { entered++; return true; },
    snapshot: async () => "[ref=e3] Email alice@example.com [ref=e4] Password SECRET-TEST",
  };
  return { root, browser, fills, fail: (value: boolean) => { fail = value; }, entered: () => entered, host: new UserFormHost(root, async () => browser) };
}

test("form contract normalizes fields and enforces domains, secrets, unique IDs and submit scope", () => {
  expect(parseUserForm(form)).toMatchObject({ domain: "example.com", fields: [{}, { secret: true }] });
  for (const invalid of [{ ...form, domain: undefined }, { ...form, fields: [form.fields[0], form.fields[0]] }, { ...form, submitAfterFill: true }, { ...form, fields: [{ id: "x", label: "Secret", type: "otp" }] }]) expect(() => parseUserForm(invalid)).toThrow();
  expect(formVaultKey({ id: "username", label: "Username", type: "text", extra_key: "shared" }, "example.com")).toBe("username:example.com");
  expect(formVaultKey({ id: "color", label: "Color", type: "text", extra_key: "favorite color" })).toBe("extra:favorite color");
  expect(formVaultKey({ id: "cc", label: "Credit card", type: "text", extra_key: "cc" })).toBeNull();
});

test("values are host-only, encrypted at rest, and duplicate submissions after restart do not fill again", async () => {
  const f = await fixture();
  await f.host.prepare("bot", "form", form);
  const receipt = await f.host.submit("bot", "form", { email: "alice@example.com", password: "SECRET-TEST" }, true);
  expect(receipt.fields.map((field) => field.status)).toEqual(["filled", "filled"]);
  expect(formatUserFormReceipt(receipt)).not.toContain("alice@example.com");
  expect(JSON.stringify(receipt)).not.toContain("SECRET-TEST");
  const restarted = new UserFormHost(f.root, async () => f.browser);
  expect(await restarted.submit("bot", "form", {})).toEqual(receipt);
  expect(f.fills).toEqual(["email", "password"]);
  await restarted.prepare("bot", "next", form);
  expect(await restarted.prefill("bot", "next")).toEqual({ email: "alice@example.com" });
  await expect(restarted.prefill("other", "next")).rejects.toThrow();
  for (const file of await readdir(f.root)) {
    const bytes = await readFile(join(f.root, file));
    expect(bytes.toString()).not.toContain("alice@example.com"); expect(bytes.toString()).not.toContain("SECRET-TEST");
    expect((await stat(join(f.root, file))).mode & 0o077).toBe(0);
  }
});

test("failed fills return redacted refs and one-shot remap discards omitted held values", async () => {
  const f = await fixture(); f.fail(true);
  await f.host.prepare("bot", "form", form);
  const held = await f.host.submit("bot", "form", { email: "alice@example.com", password: "SECRET-TEST" });
  expect(held.fields.map((field) => field.status)).toEqual(["held", "held"]);
  expect(held.snapshot).toContain("[withheld]"); expect(JSON.stringify(held)).not.toContain("SECRET-TEST");
  expect((await f.host.remap("bot", { targets: [{ fieldId: "unknown", target: { kind: "ref", value: "e3" } }] })).unknownFieldIds).toEqual(["unknown"]);
  f.fail(false);
  const remapped = await f.host.remap("bot", { targets: [{ fieldId: "email", target: { kind: "ref", value: "e3" } }] });
  expect(remapped.fields).toEqual([{ id: "email", status: "filled" }, { id: "password", status: "dropped" }]);
  expect(await f.host.remap("bot", { targets: [{ fieldId: "email", target: { kind: "ref", value: "e3" } }] })).toEqual(remapped);
  await f.host.acknowledgeRemap("bot", "form");
  await expect(f.host.remap("bot", { targets: [{ fieldId: "email", target: { kind: "ref", value: "e3" } }] })).rejects.toThrow("No held");
});

test("no Enter on failed fill, dismissal is idempotent, and preflight refuses unreachable forms", async () => {
  const f = await fixture();
  const code = { title: "Code", instruction: "Enter code", domain: "example.com", submitAfterFill: true, fields: [{ id: "otp", label: "Code", type: "otp", target: { kind: "ref", value: "e1" } }] };
  await f.host.prepare("bot", "otp", code); f.fail(true);
  expect((await f.host.submit("bot", "otp", { otp: "123456" })).submitAttempted).toBe(false); expect(f.entered()).toBe(0);
  await f.host.prepare("bot", "dismiss", code);
  await f.host.dismiss("bot", "dismiss");
  expect((await f.host.submit("bot", "dismiss", { otp: "123456" })).status).toBe("dismissed");
  f.browser.prepare = async () => ({ binding: { pageId: "page", domain: "example.com" }, reachable: [] });
  await expect(f.host.prepare("bot", "unreachable", form)).rejects.toThrow("No requested fields");
});

test("form preflight reports omitted controls and preserves that diagnostic on replay",async()=>{
 const f=await fixture();
 f.browser.prepare=async()=>({binding:{pageId:"page",domain:"example.com"},reachable:["email"],failureKinds:{password:"in_unreachable_frame"}});
 const prepared=await f.host.prepare("bot","partial",form);
 expect(prepared.fields.map(field=>field.id)).toEqual(["email"]);
 expect(prepared.preflightNote).toContain("cross-origin iframe");
 expect(await f.host.prepare("bot","partial",form)).toEqual(prepared);
 f.browser.prepare=async()=>({binding:{pageId:"page",domain:"example.com"},reachable:[],failureKinds:{email:"in_unreachable_frame",password:"in_unreachable_frame"}});
 await expect(f.host.prepare("bot","structural",form)).rejects.toThrow("was NOT shown");
});

test('a killed host records unknown effects and never repeats the browser operation after restart', async () => {
  const f = await fixture();
  const script = `import {UserFormHost} from ${JSON.stringify(join(import.meta.dir, '../src/user-form-host.ts'))};
    const browser={prepare:async f=>({binding:{pageId:'page',domain:'example.com'},reachable:f.fields.map(x=>x.id)}),fill:async()=>{process.kill(process.pid,'SIGKILL');return true},submit:async()=>true,snapshot:async()=>''};
    const host=new UserFormHost(${JSON.stringify(f.root)},async()=>browser);await host.prepare('bot','crash',${JSON.stringify(form)});await host.submit('bot','crash',{email:'synthetic@example.com',password:'synthetic-only'});`;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe' });
  await child.exited;
  const recovered = new UserFormHost(f.root, async () => f.browser);
  const receipt = await recovered.submit('bot', 'crash', { email: 'must-not-refill@example.com' });
  expect(receipt.interrupted).toBe(true); expect(receipt.fields.every((field) => field.status === 'unknown')).toBe(true);
  expect(f.fills).toEqual([]); expect(f.entered()).toBe(0);
  expect(await recovered.submit('bot', 'crash', {})).toEqual(receipt);
});


test("held form values survive waiting for a user turn and are discarded at that turn's end", async () => {
  const f=await fixture(); f.fail(true);
  await f.host.prepare("bot","form",form);
  const receipt=await f.host.submit("bot","form",{email:"private@example.test",password:"synthetic-secret"});
  expect(receipt.heldUntil).toBeUndefined();
  expect(formatUserFormReceipt(receipt)).toContain("REMAP OFFERED");
  await f.host.endTurn("bot","requesting-turn");
  await f.host.beginTurn("bot","response-turn");
  await f.host.endTurn("bot","response-turn");
  await expect(f.host.remap("bot",{targets:[{fieldId:"email",target:{kind:"ref",value:"e3"}}]})).rejects.toThrow("No held");
});

test("a new turn discards holds left by an interrupted old turn", async () => {
  const f=await fixture(); f.fail(true);
  await f.host.prepare("bot","form",form);
  await f.host.submit("bot","form",{email:"private@example.test",password:"synthetic-secret"});
  await f.host.beginTurn("bot","interrupted");
  const restarted=new UserFormHost(f.root,async()=>f.browser);
  await restarted.beginTurn("bot","next");
  await expect(restarted.remap("bot",{targets:[{fieldId:"email",target:{kind:"ref",value:"e3"}}]})).rejects.toThrow("No held");
});
