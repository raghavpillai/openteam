// Reviewed user forms filled into real pages: frames, dropdowns, document
// binding across host restarts, and fills that must never land elsewhere.
import { expect } from "bun:test";
import { join } from "node:path";
import type { UserForm } from "@openteam/contracts";
import { FormPreparationError, UserFormHost } from "../../src/user-form-host";
import { formAdapter, realBrowserTest, refIn, text, withRealSession } from "./real-browser";

const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

realBrowserTest("form values fill a cross-origin card frame and refuse an insecure foreign frame", () => withRealSession(async ({ session, serve, root, page }) => {
  // The security code's mask cancels a bulk insert, so it only takes one key at a time.
  const payments = serve(`<!doctype html><label for="cc">Card number</label><input id="cc" autocomplete="cc-number">
<label for="month">Expiry month</label><select id="month"><option value="">MM</option>${months.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
<label for="cvc">Security code</label><input id="cvc" autocomplete="cc-csc">
<script>document.getElementById("cvc").addEventListener("beforeinput", e => { if (e.data && e.data.length > 1) e.preventDefault(); });</script>`);
  const shop = serve((request) => `<!doctype html><label for="email">Email</label><input id="email">
    <iframe title="Secure card payment" style="width:420px;height:260px" src="http://${new URL(request.url).pathname === "/foreign" ? "pay.example" : "localhost"}:${payments.port}/card"></iframe>`);
  const host = new UserFormHost(join(root, "encrypted"), async () => formAdapter(session));
  await session.execute("browser_navigate", { url: shop.url.origin });
  const live = await page();
  const card = live.frames().find((frame: any) => frame !== live.mainFrame())!;
  await card.waitForSelector("#cvc");
  // The card frame is another site in its own process: the shop's page cannot script it.
  expect(await card.evaluate(() => { try { return Boolean(parent.document); } catch { return false; } })).toBe(false);
  const cardRef = refIn(text(await session.execute("browser_snapshot", {})), 'textbox "Card number"');

  const form: UserForm = { title: "Pay", instruction: "Card", domain: "127.0.0.1", reason: "checkout", fields: [
    { id: "email", label: "Email", type: "email", target: { kind: "selector", value: "#email" } },
    { id: "cc", label: "Card number", type: "text", secret: true, target: { kind: "ref", value: cardRef } },
    { id: "exp", label: "Expiry month", type: "text", secret: true, target: { kind: "label", value: "Expiry month" } },
    { id: "cvc", label: "Security code", type: "text", secret: true, target: { kind: "selector", value: "#cvc" } },
  ] };
  const prepared = await host.prepare("bot", "card", form);
  expect(prepared.fields.map((field) => field.id)).toEqual(["email", "cc", "exp", "cvc"]);
  expect(prepared).not.toHaveProperty("preflightNote");
  const receipt = await host.submit("bot", "card", { email: "buyer@example.test", cc: "4242424242424242", exp: "08/27", cvc: "123" });
  expect(receipt.fields).toEqual(["email", "cc", "exp", "cvc"].map((id) => ({ id, status: "filled" })));
  expect(await live.locator("#email").inputValue()).toBe("buyer@example.test");
  expect(await card.evaluate(() => ["cc", "month", "cvc"].map((id) => (document.getElementById(id) as HTMLInputElement).value)))
    .toEqual(["4242424242424242", "08", "123"]);
  expect(JSON.stringify(receipt)).not.toMatch(/4242424242424242|08\/27|buyer@example/);
  const after = await session.formSnapshot((await session.formPages("127.0.0.1"))[0]!);
  expect(after).toContain("Card number");
  expect(after).not.toContain("4242424242424242");

  // An http frame from another site is not written, at preflight or at fill time.
  await session.execute("browser_navigate", { url: `${shop.url.origin}/foreign` });
  const foreign = live.frames().find((frame: any) => frame !== live.mainFrame())!;
  await foreign.waitForSelector("#cc");
  const refused = await host.prepare("bot", "foreign", { ...form, fields: [form.fields[3]!] }).catch((error) => error);
  expect(refused).toBeInstanceOf(FormPreparationError);
  expect(refused.body).toEqual({ error: "form_preflight_failed", fieldKinds: { cvc: "frame_origin_refused" } });
  const binding = (await session.formPages("127.0.0.1"))[0]!;
  await session.prepareForm(binding, { ...form, fields: [form.fields[0]!] });
  await expect(session.fillForm(binding, form.fields[3]!, "999")).rejects.toMatchObject({ kind: "frame_origin_refused" });
  expect(await foreign.locator("#cvc").inputValue()).toBe("");
}, ["--no-sandbox", "--site-per-process", "--host-resolver-rules=MAP pay.example 127.0.0.1"]), 90_000);

