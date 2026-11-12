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

realBrowserTest("form values fill native dropdowns by expiry, country code, number, and visible label", () => withRealSession(async ({ session, serve, root, page }) => {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const server = serve(`<!doctype html>
<label for="month">Expiry month</label><select id="month"><option value="">Month</option>${months.map((m, i) => `<option value="${m}">${m} - ${names[i]}</option>`).join("")}</select>
<label for="year">Expiry year</label><select id="year"><option value="">Year</option>${Array.from({ length: 10 }, (_, i) => `<option>${2026 + i}</option>`).join("")}</select>
<label for="country">Country</label><select id="country"><option value="CA">Canada</option><option value="US">United States</option></select>
<label for="plan">Plan</label><select id="plan"><option value="basic">Basic plan</option><option value="pro">Pro plan</option></select>`);
  const host = new UserFormHost(join(root, "encrypted"), async () => formAdapter(session));
  const form = (fields: UserForm["fields"]): UserForm => ({ title: "Checkout", instruction: "Card", domain: "127.0.0.1", fields });
  await session.execute("browser_navigate", { url: server.url.origin });
  const live = await page();
  await host.prepare("bot", "selects", form([
    { id: "exp_month", label: "Expiry month", type: "text", secret: true, target: { kind: "selector", value: "#month" } },
    { id: "exp_year", label: "Expiry year", type: "text", secret: true, target: { kind: "label", value: "Expiry year" } },
    { id: "country", label: "Country", type: "text", target: { kind: "selector", value: "#country" } },
    { id: "plan", label: "Plan", type: "select", options: [{ label: "Pro", value: "Pro plan" }], target: { kind: "selector", value: "#plan" } },
  ]));
  const receipt = await host.submit("bot", "selects", { exp_month: "08/27", exp_year: "08/27", country: "US", plan: "Pro plan" });
  expect(receipt.fields.map((field) => field.status)).toEqual(["filled", "filled", "filled", "filled"]);
  expect(await live.evaluate(() => ["month", "year", "country", "plan"].map((id) => (document.getElementById(id) as HTMLSelectElement).value)))
    .toEqual(["08", "2027", "US", "pro"]);
  expect(JSON.stringify(receipt)).not.toContain("08/27");

  await host.prepare("bot", "unmatched", form([{ id: "country", label: "Country", type: "text", target: { kind: "selector", value: "#country" } }]));
  const missed = await host.submit("bot", "unmatched", { country: "Atlantis" });
  expect(missed.fields).toEqual([{ id: "country", status: "held" }]);
  expect(missed.fillFailureKinds).toEqual({ country: "fill_op_failed" });
  expect(await live.locator("#country").inputValue()).toBe("US");
}), 60_000);

realBrowserTest("reviewed form documents survive host restart, refuse reload, and explicitly remap without submit", () => withRealSession(async ({ session, serve, root, context, page: ensurePage }) => {
  const server = serve('<!doctype html><label for="otp">Verification code</label><input id="otp" autocomplete="one-time-code"><output id="submitted">0</output><script>document.querySelector("input").onkeydown=e=>{if(e.key==="Enter")document.querySelector("output").textContent="1"}</script>');
  const store = join(root, "encrypted");
  const adapter = formAdapter(session);
  let host = new UserFormHost(store, async () => adapter);
  const form: UserForm = { title: "Synthetic code", instruction: "Test only", domain: "127.0.0.1", submitAfterFill: true,
    fields: [{ id: "otp", label: "Verification code", type: "otp", target: { kind: "selector", value: "#otp" } }] };
  await session.execute("browser_navigate", { url: server.url.origin });
  const page = await ensurePage();
  const otp = page.locator("#otp");
  const submitted = () => page.locator("#submitted").textContent();
  await host.prepare("bot", "restart", form);
  host = new UserFormHost(store, async () => adapter);
  const receipt = await host.submit("bot", "restart", { otp: "246810" });
  expect(receipt.fields[0]?.status).toBe("filled");
  expect(receipt.submitSucceeded).toBe(true);
  expect(await submitted()).toBe("1");
  expect(JSON.stringify(receipt)).not.toContain("246810");
  expect(await session.formSnapshot((await session.formPages(form.domain!))[0]!)).not.toContain("246810");
  expect(await otp.getAttribute("data-openteam-private")).toBe("true");

  await page.reload();
  await host.prepare("bot", "reload", form);
  // The host restarts while a card waits; the browser then replaces its doc.
  host = new UserFormHost(store, async () => adapter);
  await page.reload();
  const held = await host.submit("bot", "reload", { otp: "135790" });
  expect(held.pageMoved).toEqual({ signal: "navigated" });
  expect(held.fields[0]?.status).toBe("held");
  expect(held.submitAttempted).toBe(false);
  expect(await otp.inputValue()).toBe("");
  expect(JSON.stringify(held)).not.toContain("135790");
  const remapped = await host.remap("bot", { targets: [{ fieldId: "otp", target: { kind: "selector", value: "#otp" } }] });
  expect(remapped.fields[0]?.status).toBe("filled");
  expect(remapped.submitAttempted).toBe(false);
  expect(await otp.inputValue()).toBe("135790");
  expect(await submitted()).toBe("0");
  expect(JSON.stringify(remapped)).not.toContain("135790");

  const binding = (await session.formPages(form.domain!))[0]!;
  await session.prepareForm(binding, form);
  await page.reload();
  await expect(session.submitForm(binding, form.fields[0]!)).rejects.toMatchObject({ kind: "page_moved" });
  expect(await submitted()).toBe("0");
  // Bindings missing document metadata must never write.
  const unprepared = (await session.formPages(form.domain!))[0]!;
  await expect(session.fillForm(unprepared, form.fields[0]!, "246810")).rejects.toMatchObject({ kind: "page_moved" });
  expect(await otp.inputValue()).toBe("");

  // Multiple matching tabs cannot redirect an explicit remap from its tab.
  const other = await context.newPage(); await other.goto(server.url.origin);
  (session as any).trackPage(other);
  const rebound = await session.rebindForm(binding, form);
  expect(rebound.pageId).toBe(binding.pageId);
  expect(await session.fillForm(rebound, form.fields[0]!, "246810")).toBe(true);
  expect(await otp.inputValue()).toBe("246810");
  expect(await other.locator("#otp").inputValue()).toBe("");
}, ["--no-sandbox"]), 60_000);

realBrowserTest("snapshots and fills handle shadow DOM, cross-origin frames, controlled inputs, OTP and remaps", () => withRealSession(async ({ session, serve, page: ensurePage }) => {
  const child = serve("<label>Frame field <input></label>");
  const server = serve(`<!doctype html><title>DOM fixture</title><h1>Visible heading</h1><fixture-login id="shadow" style="display:block"></fixture-login><label>Masked number <input id="masked"></label><label>Replaceable <input id="replaceable"></label><form id="otp">${Array.from({ length: 6 }, (_, i) => `<input aria-label="Code ${i + 1}" maxlength="1" inputmode="numeric" style="width:25px">`).join("")}</form><iframe src="http://localhost:${child.port}/"></iframe><script>
 shadow.attachShadow({mode:'closed'}).innerHTML='<label>Shadow field <input></label>';
 masked.addEventListener('input',e=>{if(!e.isTrusted)masked.value='';});
 for(const input of otp.querySelectorAll('input'))input.addEventListener('input',()=>{if(input.value.length===1)input.nextElementSibling?.focus()});
 </script>`);
  await session.execute("browser_navigate", { url: server.url.origin });
  let snapshot = text(await session.execute("browser_snapshot", {}));
  for (const expected of ["Visible heading", "Shadow field", "Frame field", "[gen="]) expect(snapshot).toContain(expected);
  const ref = (label: string) => refIn(snapshot, label);
  for (const [label, value] of [["Shadow field", "shadow fixture"], ["Frame field", "frame fixture"], ["Masked number", "12345"]])
    snapshot = text(await session.execute("browser_type", { target: ref(label!), element: label, text: value }));
  const page = await ensurePage(); expect(await page.locator("#masked").inputValue()).toBe("12345");
  const binding = (await session.formPages("127.0.0.1"))[0]!;
  const previous = ref("Replaceable");
  const replacement = { id: "replacement", label: "Replaceable", type: "text" as const, target: { kind: "ref" as const, value: previous } };
  const code = { id: "code", label: "Code", type: "otp" as const, target: { kind: "selector" as const, value: "#otp input:first-child" } };
  await session.prepareForm(binding, { title: "Reviewed fields", instruction: "Fixture", domain: "127.0.0.1", fields: [replacement, code] });
  await page.locator("#replaceable").evaluate((node: HTMLElement) => node.replaceWith(node.cloneNode(true)));
  expect(await session.fillForm(binding, replacement, "private replacement")).toBe(true);
  expect(await page.locator("#replaceable").inputValue()).toBe("private replacement");
  await session.fillForm(binding, code, "731942");
  expect(await page.locator("#otp input").evaluateAll((nodes: HTMLInputElement[]) => nodes.map((node) => node.value).join(""))).toBe("731942");
  snapshot = text(await session.execute("browser_snapshot", {})); expect(snapshot).not.toContain("731942"); expect(snapshot).not.toContain("private replacement");
  await page.locator("#replaceable").evaluate((node: HTMLElement) => node.style.display = "none");
  const hidden = { id: "hidden", label: "Replaceable", type: "text" as const, target: { kind: "selector" as const, value: "#replaceable" } };
  expect(await session.prepareForm(binding, { title: "Hidden", instruction: "Fixture", domain: "127.0.0.1", fields: [hidden] })).toMatchObject({ reachable: [], failureKinds: { hidden: "hidden_target" } });
  await expect(session.fillForm(binding, hidden, "never written")).rejects.toThrow("hidden");
  await page.evaluate(() => history.pushState({}, "", "/next"));
  await expect(session.fillForm(binding, { id: "moved", label: "Masked number", type: "text", target: { kind: "selector", value: "#masked" } }, "never written")).rejects.toThrow("moved");
}), 60_000);
