import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";
import { FormPreparationError, UserFormHost, type FormBrowser } from "../../src/user-form-host";
import type { UserForm } from "@openteam/contracts";

const html = (body: string) => new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html" } });
const months = Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${String(i + 1).padStart(2, "0")}</option>`).join("");
// The security code's mask cancels a bulk insert, so it only takes one key at a time.
const cardFrame = `<label for="cc">Card number</label><input id="cc" autocomplete="cc-number">
<label for="month">Expiry month</label><select id="month"><option value="">MM</option>${months}</select>
<label for="cvc">Security code</label><input id="cvc" autocomplete="cc-csc">
<script>document.getElementById("cvc").addEventListener("beforeinput", e => { if (e.data && e.data.length > 1) e.preventDefault(); });</script>`;

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("form values fill a cross-origin card frame and refuse an insecure foreign frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "cross-origin-form-"));
  const payments = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => html(cardFrame) });
  const shop = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => html(`<label for="email">Email</label><input id="email">
    <iframe title="Secure card payment" style="width:420px;height:260px" src="http://${new URL(request.url).pathname === "/foreign" ? "pay.example" : "localhost"}:${payments.port}/card"></iframe>`) });
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({ headless: true, executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,
    args: ["--no-sandbox", "--site-per-process", `--host-resolver-rules=MAP pay.example 127.0.0.1`] });
  const session = new (BrowserUseSession as any)(browser, await browser.newContext(), root) as BrowserUseSession;
  const adapter: FormBrowser = {
    prepare: async form => { const [binding] = await session.formPages(form.domain!); return { binding: binding!, ...await session.prepareForm(binding!, form) }; },
    fill: (binding, field, value) => session.fillForm(binding, field, value),
    submit: (binding, field) => session.submitForm(binding, field),
    snapshot: binding => session.formSnapshot(binding),
  };
  const host = new UserFormHost(join(root, "encrypted"), async () => adapter);
  try {
    await session.execute("browser_navigate", { url: shop.url.origin });
    const live = await (session as any).ensurePage();
    const card = live.frames().find((frame: any) => frame !== live.mainFrame())!;
    await card.waitForSelector("#cvc");
    // The card frame is another site in its own process: the shop's page cannot script it.
    expect(await card.evaluate(() => { try { return Boolean(parent.document); } catch { return false; } })).toBe(false);
    const snapshot = (await session.execute("browser_snapshot", {})).content.map((part: any) => part.text ?? "").join("\n");
    const cardRef = /textbox "Card number"[^\n]*\[ref=(e\d+)\]/.exec(snapshot)?.[1];
    expect(cardRef).toBeDefined();

    const form: UserForm = { title: "Pay", instruction: "Card", domain: "127.0.0.1", reason: "checkout", fields: [
      { id: "email", label: "Email", type: "email", target: { kind: "selector", value: "#email" } },
      { id: "cc", label: "Card number", type: "text", secret: true, target: { kind: "ref", value: cardRef! } },
      { id: "exp", label: "Expiry month", type: "text", secret: true, target: { kind: "label", value: "Expiry month" } },
      { id: "cvc", label: "Security code", type: "text", secret: true, target: { kind: "selector", value: "#cvc" } },
    ] };
    const prepared = await host.prepare("bot", "card", form);
    expect(prepared.fields.map(field => field.id)).toEqual(["email", "cc", "exp", "cvc"]);
    expect(prepared).not.toHaveProperty("preflightNote");
    const receipt = await host.submit("bot", "card", { email: "buyer@example.test", cc: "4242424242424242", exp: "08/27", cvc: "123" });
    expect(receipt.fields).toEqual(["email", "cc", "exp", "cvc"].map(id => ({ id, status: "filled" })));
    expect(await live.locator("#email").inputValue()).toBe("buyer@example.test");
    expect(await card.evaluate(() => ["cc", "month", "cvc"].map(id => (document.getElementById(id) as HTMLInputElement).value)))
      .toEqual(["4242424242424242", "08", "123"]);
    expect(JSON.stringify(receipt)).not.toMatch(/4242424242424242|08\/27|buyer@example/);
    const after = await session.formSnapshot((await session.formPages("127.0.0.1"))[0]!);
    expect(after).toContain("Card number");
    expect(after).not.toContain("4242424242424242");

    // An http frame from another site is not written, at preflight or at fill time.
    await session.execute("browser_navigate", { url: `${shop.url.origin}/foreign` });
    const foreign = live.frames().find((frame: any) => frame !== live.mainFrame())!;
    await foreign.waitForSelector("#cc");
    const refused = await host.prepare("bot", "foreign", { ...form, fields: [form.fields[3]!] }).catch(error => error);
    expect(refused).toBeInstanceOf(FormPreparationError);
    expect(refused.body).toEqual({ error: "form_preflight_failed", fieldKinds: { cvc: "frame_origin_refused" } });
    const binding = (await session.formPages("127.0.0.1"))[0]!;
    await session.prepareForm(binding, { ...form, fields: [form.fields[0]!] });
    await expect(session.fillForm(binding, form.fields[3]!, "999")).rejects.toMatchObject({ kind: "frame_origin_refused" });
    expect(await foreign.locator("#cvc").inputValue()).toBe("");
  } finally {
    await browser.close(); await driver.stop(); shop.stop(true); payments.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
