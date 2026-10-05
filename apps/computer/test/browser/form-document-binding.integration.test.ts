import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";
import { UserFormHost, type FormBrowser } from "../../src/user-form-host";
import type { UserForm } from "@openteam/contracts";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("reviewed form documents survive host restart, refuse reload, and explicitly remap without submit", async () => {
  const root = await mkdtemp(join(tmpdir(), "form-document-binding-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    '<!doctype html><label for="otp">Verification code</label><input id="otp" autocomplete="one-time-code"><output id="submitted">0</output><script>document.querySelector("input").onkeydown=e=>{if(e.key==="Enter")document.querySelector("output").textContent="1"}</script>',
    { headers: { "content-type": "text/html" } }) });
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({ headless: true, executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE, args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
  const internal = session as any;
  const adapter: FormBrowser = {
    prepare: async form => { const [binding] = await session.formPages(form.domain!); return { binding: binding!, ...await session.prepareForm(binding!, form) }; },
    rebind: (binding, form) => session.rebindForm(binding, form),
    fill: (binding, field, value) => session.fillForm(binding, field, value),
    submit: (binding, field) => session.submitForm(binding, field),
    snapshot: binding => session.formSnapshot(binding),
  };
  const store = join(root, "encrypted");
  let host = new UserFormHost(store, async () => adapter);
  const form: UserForm = { title: "Synthetic code", instruction: "Test only", domain: "127.0.0.1", submitAfterFill: true,
    fields: [{ id: "otp", label: "Verification code", type: "otp", target: { kind: "selector", value: "#otp" } }] };
  try {
    await session.execute("browser_navigate", { url: server.url.origin });
    const page = await internal.ensurePage();
    await host.prepare("bot", "restart", form);
    host = new UserFormHost(store, async () => adapter);
    const receipt = await host.submit("bot", "restart", { otp: "246810" });
    expect(receipt.fields[0]?.status).toBe("filled");
    expect(receipt.submitSucceeded).toBe(true);
    expect(await page.locator("#submitted").textContent()).toBe("1");
    expect(JSON.stringify(receipt)).not.toContain("246810");
    expect(await session.formSnapshot((await session.formPages(form.domain!))[0]!)).not.toContain("246810");
    expect(await page.locator("#otp").getAttribute("data-openteam-private")).toBe("true");

    await page.reload();
    await host.prepare("bot", "reload", form);
    // The host restarts while a card waits; the browser then replaces its doc.
    host = new UserFormHost(store, async () => adapter);
    await page.reload();
    const held = await host.submit("bot", "reload", { otp: "135790" });
    expect(held.pageMoved).toEqual({ signal: "navigated" });
    expect(held.fields[0]?.status).toBe("held");
    expect(held.submitAttempted).toBe(false);
    expect(await page.locator("#otp").inputValue()).toBe("");
    expect(JSON.stringify(held)).not.toContain("135790");
    const remapped = await host.remap("bot", { targets: [{ fieldId: "otp", target: { kind: "selector", value: "#otp" } }] });
    expect(remapped.fields[0]?.status).toBe("filled");
    expect(remapped.submitAttempted).toBe(false);
    expect(await page.locator("#otp").inputValue()).toBe("135790");
    expect(await page.locator("#submitted").textContent()).toBe("0");
    expect(JSON.stringify(remapped)).not.toContain("135790");

    const binding = (await session.formPages(form.domain!))[0]!;
    await session.prepareForm(binding, form);
    await page.reload();
    await expect(session.submitForm(binding, form.fields[0]!)).rejects.toMatchObject({ kind: "page_moved" });
    expect(await page.locator("#submitted").textContent()).toBe("0");
    // Pre-upgrade bindings missing document metadata must never write.
    const legacy = (await session.formPages(form.domain!))[0]!;
    await expect(session.fillForm(legacy, form.fields[0]!, "246810")).rejects.toMatchObject({ kind: "page_moved" });
    expect(await page.locator("#otp").inputValue()).toBe("");

    // Multiple matching tabs cannot redirect an explicit remap from its tab.
    const other = await context.newPage(); await other.goto(server.url.origin);
    internal.trackPage(other);
    const rebound = await session.rebindForm(binding, form);
    expect(rebound.pageId).toBe(binding.pageId);
    expect(await session.fillForm(rebound, form.fields[0]!, "246810")).toBe(true);
    expect(await page.locator("#otp").inputValue()).toBe("246810");
    expect(await other.locator("#otp").inputValue()).toBe("");
  } finally {
    await browser.close(); await driver.stop(); server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
