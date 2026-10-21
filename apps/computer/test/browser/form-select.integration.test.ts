import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";
import { UserFormHost, type FormBrowser } from "../../src/user-form-host";
import type { UserForm } from "@openteam/contracts";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  .map((name, i) => `<option value="${String(i + 1).padStart(2, "0")}">${String(i + 1).padStart(2, "0")} - ${name}</option>`).join("");
const years = Array.from({ length: 10 }, (_, i) => `<option>${2026 + i}</option>`).join("");
const page = `<!doctype html>
<label for="month">Expiry month</label><select id="month"><option value="">Month</option>${months}</select>
<label for="year">Expiry year</label><select id="year"><option value="">Year</option>${years}</select>
<label for="country">Country</label><select id="country"><option value="CA">Canada</option><option value="US">United States</option></select>
<label for="plan">Plan</label><select id="plan"><option value="basic">Basic plan</option><option value="pro">Pro plan</option></select>`;

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("form values fill native dropdowns by expiry, country code, number, and visible label", async () => {
  const root = await mkdtemp(join(tmpdir(), "form-select-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(page, { headers: { "content-type": "text/html" } }) });
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({ headless: true, executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE, args: ["--no-sandbox"] });
  const session = new (BrowserUseSession as any)(browser, await browser.newContext(), root) as BrowserUseSession;
  const adapter: FormBrowser = {
    prepare: async form => { const [binding] = await session.formPages(form.domain!); return { binding: binding!, ...await session.prepareForm(binding!, form) }; },
    fill: (binding, field, value) => session.fillForm(binding, field, value),
    submit: (binding, field) => session.submitForm(binding, field),
    snapshot: binding => session.formSnapshot(binding),
  };
  const host = new UserFormHost(join(root, "encrypted"), async () => adapter);
  const form = (fields: UserForm["fields"]): UserForm => ({ title: "Checkout", instruction: "Card", domain: "127.0.0.1", fields });
  try {
    await session.execute("browser_navigate", { url: server.url.origin });
    const live = await (session as any).ensurePage();
    await host.prepare("bot", "selects", form([
      { id: "exp_month", label: "Expiry month", type: "text", secret: true, target: { kind: "selector", value: "#month" } },
      { id: "exp_year", label: "Expiry year", type: "text", secret: true, target: { kind: "label", value: "Expiry year" } },
      { id: "country", label: "Country", type: "text", target: { kind: "selector", value: "#country" } },
      { id: "plan", label: "Plan", type: "select", options: [{ label: "Pro", value: "Pro plan" }], target: { kind: "selector", value: "#plan" } },
    ]));
    const receipt = await host.submit("bot", "selects", { exp_month: "08/27", exp_year: "08/27", country: "US", plan: "Pro plan" });
    expect(receipt.fields.map(field => field.status)).toEqual(["filled", "filled", "filled", "filled"]);
    expect(await live.evaluate(() => ["month", "year", "country", "plan"].map(id => (document.getElementById(id) as HTMLSelectElement).value)))
      .toEqual(["08", "2027", "US", "pro"]);
    expect(JSON.stringify(receipt)).not.toContain("08/27");

    await host.prepare("bot", "unmatched", form([{ id: "country", label: "Country", type: "text", target: { kind: "selector", value: "#country" } }]));
    const missed = await host.submit("bot", "unmatched", { country: "Atlantis" });
    expect(missed.fields).toEqual([{ id: "country", status: "held" }]);
    expect(missed.fillFailureKinds).toEqual({ country: "fill_op_failed" });
    expect(await live.locator("#country").inputValue()).toBe("US");
  } finally {
    await browser.close(); await driver.stop(); server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
