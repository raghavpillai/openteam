import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UserForm } from "@openteam/contracts";
import { BrowserUseSession } from "../../src/browser/use";
import { snapshotAcrossFrames, frameRefsByPage } from "../../src/browser/reference-driver";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("stable refs survive find and scoped observations, retire on navigation, and upgrade live positional documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "stable-ref-lifetime-"));
  const child = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response('<button id="child">Child button</button>', { headers: { "content-type": "text/html" } }) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<button id="main">Main button</button><div id="recovery"></div><label for="otp">Enter verification code</label><input id="otp" autocomplete="one-time-code"><iframe src="http://localhost:${child.port}"></iframe>`, { headers: { "content-type": "text/html" } }) });
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({ headless: true, executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE, args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
  const internal = session as any;
  try {
    const page = await internal.ensurePage();
    await page.goto(server.url.origin);
    const positional = await snapshotAcrossFrames(context, page, { stableRefs: false, maxDepth: 20 });
    frameRefsByPage.set(page, positional.refOwners);
    const old = positional.lines.find((line: string) => line.includes('button "Main button"'))!.match(/\[ref=(e\d+)\]/)![1]!;
    await session.execute("browser_snapshot", {});
    await expect(internal.requireRef(page, old)).rejects.toThrow("stale");
    const capture = await internal.captureSnapshot(page);
    const current = capture.lines.find((line: string) => line.includes('button "Main button"'))!.match(/\[ref=(e\d+)\]/)![1]!;
    expect(current).not.toBe(old);
    expect(await (await internal.requireRef(page, current)).getAttribute("id")).toBe("main");
    const childRef = capture.lines.find((line: string) => line.includes('button "Child button"'))!.match(/\[ref=(e\d+)\]/)![1]!;
    await session.execute("browser_snapshot", { selector: "#main" });
    expect(await (await internal.requireRef(page, childRef)).getAttribute("id")).toBe("child");
    // A new editable control before the OTP would receive its old positional
    // ref. Check the actual destination, including a previously prepared form.
    const otpRef = capture.lines.find((line: string) => line.includes('textbox "Enter verification code"'))!.match(/\[ref=(e\d+)\]/)![1]!;
    const form: UserForm = { title: "Code", instruction: "Synthetic fixture", domain: "127.0.0.1",
      fields: [{ id: "otp", label: "Verification code", type: "otp", target: { kind: "ref", value: otpRef } }] };
    const binding = (await session.formPages(form.domain!))[0]!;
    await session.prepareForm(binding, form);
    await page.locator("#recovery").evaluate((node: HTMLElement) => {
      node.innerHTML = '<a href="#help">Recovery</a><input id="decoy" aria-label="Other code">';
    });
    await session.execute("browser_find", { text: "verification code" });
    expect(await session.fillForm(binding, form.fields[0]!, "246810")).toBe(true);
    expect(await page.locator("#otp").inputValue()).toBe("246810");
    expect(await page.locator("#decoy").inputValue()).toBe("");
    const freshBinding = (await session.formPages(form.domain!))[0]!;
    expect((await session.prepareForm(freshBinding, form)).reachable).toEqual(["otp"]);

    await page.reload();
    await session.execute("browser_snapshot", {});
    await expect(internal.requireRef(page, current)).rejects.toThrow("stale");
    await expect(internal.requireRef(page, childRef)).rejects.toThrow("stale");
  } finally {
    await browser.close(); await driver.stop(); server.stop(true); child.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
