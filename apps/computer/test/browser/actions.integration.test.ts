// Browser actions against real pages: result text, clicks, typing, forms,
// find, hover, console and waits.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { findPageLines } from "../../src/browser/find";
import { realBrowserTest, refIn, text, withRealSession } from "./real-browser";

realBrowserTest("reference browser actions execute against a real synthetic page", () => withRealSession(async ({ session, serve, page: ensurePage }) => {
  const server = serve(`<!doctype html><title>Contract fixture</title><button id="hold" style="width:150px;height:80px">Hold</button><input aria-label="Name"><select aria-label="Region"><option value="ny">New York</option><option value="ca">California</option></select><div style="height:2000px">Scroll area</div><script>let down=0;window.holds=[];window.wheels=0;document.addEventListener('mousedown',()=>down=performance.now());document.addEventListener('mouseup',()=>holds.push(performance.now()-down));document.addEventListener('wheel',()=>wheels++);</script>`);
  const url = `http://127.0.0.1:${server.port}/`;
  expect(text(await session.execute("browser_navigate", { url }))).toStartWith(
    `### Result\nNavigated to ${url}\n### Page\n- Page URL: ${url}\n- Page Title: Contract fixture`);
  const snapshot = text(await session.execute("browser_snapshot", {}));
  expect(snapshot).toContain("Captured page snapshot (3 interactive refs)");
  const ref = (label: string) => refIn(snapshot, label);
  const clicked = await session.execute("browser_click", { target: ref("Hold"), element: "Hold", modifiers: ["Shift"] });
  expect(text(clicked)).toStartWith("### Result\nClicked Hold\n### Page\n- Page URL:");
  const page = await ensurePage();
  expect(await page.evaluate(() => (window as any).holds.length)).toBe(1);
  // browser_type fills the whole text at once, replacing what was there.
  await page.locator("input").fill("old value");
  expect(text(await session.execute("browser_type", { target: ref("Name"), element: "Name", text: "Fixture" })))
    .toStartWith("### Result\nFilled Name\n### Page");
  expect(await page.locator("input").inputValue()).toBe("Fixture");
  await session.execute("browser_type", { target: ref("Name"), element: "Name", text: "!", slowly: true });
  expect(await page.locator("input").inputValue()).toBe("Fixture!");
  const selected = await session.execute("browser_select_option", { target: ref("Region"), element: "Region", values: ["new york"] });
  expect(text(selected)).toStartWith(
    '### Result\nSelected ["ny"] in Region (matched the requested value to the page\'s option by its visible label)');
  expect(await page.locator("select").inputValue()).toBe("ny");
  const scoped = text(await session.execute("browser_snapshot", { target: ref("Region"), depth: 3 }));
  expect(scoped).toContain("### Snapshot");
  expect(scoped).toContain("New York");
  expect(scoped).not.toContain("Scroll area");
  expect(text(await session.execute("browser_tabs", { action: "list" }))).toBe(`### Open tabs\n- 0: (current) [Contract fixture](${url})`);
  const opened = text(await session.execute("browser_tabs", { action: "new", url }));
  expect(opened).toContain(`### Open tabs\n- 0: [Contract fixture](${url})\n- 1: (current) [Contract fixture](${url})`);
  const shot = await session.execute("browser_take_screenshot", {});
  expect(text(shot)).toStartWith("### Result\nSaved a screenshot to ");
  expect((await readFile(shot.details.path as string)).subarray(1, 4).toString()).toBe("PNG");
}), 30_000);

realBrowserTest("blocked clicks yield promptly without forcing or replaying; transient blockers still settle", () => withRealSession(async ({ session, serve, page: ensurePage }) => {
  const server = serve('<!doctype html><button id="target" onclick="window.clicks++">Target</button><div id="cover" style="display:none;position:fixed;inset:0;background:white">Cover</div><script>window.clicks=0</script>');
  await session.execute("browser_navigate", { url: server.url.href });
  const page = await ensurePage();
  const clicks = () => page.evaluate(() => (window as any).clicks);
  const ref = async () => refIn(text(await session.execute("browser_snapshot", {})), '"Target"');
  for (const mode of ["hidden", "covered"]) {
    const target = await ref();
    await page.evaluate((mode: string) => { document.getElementById(mode === "hidden" ? "target" : "cover")!.style.display = mode === "hidden" ? "none" : "block"; }, mode);
    const start = Date.now();
    let failure = "";
    try { await session.execute("browser_click", { ref: target }); } catch (error) { failure = String(error); }
    expect(failure).toContain("Timeout");
    expect(failure).toContain("fresh browser_snapshot");
    expect(Date.now() - start).toBeLessThan(13_000);
    expect(await clicks()).toBe(0);
    await page.evaluate(() => { document.getElementById("target")!.style.display = "block"; document.getElementById("cover")!.style.display = "none"; });
  }
  const target = await ref();
  await page.evaluate(() => { document.getElementById("cover")!.style.display = "block"; setTimeout(() => document.getElementById("cover")!.style.display = "none", 700); });
  await session.execute("browser_click", { ref: target });
  expect(await clicks()).toBe(1);
  await session.execute("browser_click", { ref: target, doubleClick: true, holdDurationMs: 120 });
  expect(await clicks()).toBe(3);
}), 70_000);

realBrowserTest("temporal controls identify their type and recover from unsupported typing through fill", () => withRealSession(async ({ session, serve, page: ensurePage }) => {
  const kinds = ["date", "time", "month", "datetime-local"];
  const values = ["2027-04-19", "16:45", "2027-04", "2027-04-19T16:45"];
  const server = serve('<!doctype html><title>Temporal controls</title>' + kinds.map((kind) => `<input type="${kind}" aria-label="${kind}">`).join("") + '<input type="date" readonly aria-label="locked" value="2020-01-01">');
  const snapshot = text(await session.execute("browser_navigate", { url: `http://127.0.0.1:${server.port}` }));
  const ref = (name: string) => refIn(snapshot, `"${name}"`);
  const page = await ensurePage();
  for (const [i, kind] of kinds.entries()) {
    const input = page.getByLabel(kind, { exact: true });
    expect(snapshot).toContain(`input-type=${kind}`);
    // Typing one character at a time cannot drive a date/time control; filling can.
    await expect(session.execute("browser_type", { target: ref(kind), text: values[i], slowly: true })).rejects.toThrow("without slowly");
    expect(await input.inputValue()).toBe("");
    await session.execute("browser_type", { target: ref(kind), text: values[i] });
    expect(await input.inputValue()).toBe(values[i]);
    await input.fill("");
    const result = await session.execute("browser_fill_form", { fields: [{ target: ref(kind), name: kind, type: "textbox", value: values[i] }] });
    expect((result as any).isError).toBe(false);
    expect(await input.inputValue()).toBe(values[i]);
  }
  await expect(session.execute("browser_type", { target: ref("locked"), text: "2030-01-01" })).rejects.toThrow("not an enabled");
  expect(await page.getByLabel("locked").inputValue()).toBe("2020-01-01");
}), 30_000);

realBrowserTest("batch fills text and checkbox states, and stops after unavailable targets", () => withRealSession(async ({ session, serve, page: ensurePage }) => {
  const server = serve('<html><title>Batch</title><input aria-label="Name"><textarea aria-label="Notes"></textarea><input type="checkbox" aria-label="Checked" checked><input type="checkbox" aria-label="Unchecked"><input type="password" aria-label="Password"><button>Submit</button></html>');
  const snapshot = text(await session.execute("browser_navigate", { url: `http://127.0.0.1:${server.port}` }));
  const ref = (label: string) => refIn(snapshot, `"${label}"`);
  const fields = [{ target: ref("Name"), name: "Name", type: "textbox", value: "Parity926" }, { target: ref("Notes"), name: "Notes", type: "textbox", value: "Line one\nLine two" },
    { target: ref("Checked"), name: "Checked", type: "checkbox", value: "false" }, { target: ref("Unchecked"), name: "Unchecked", type: "checkbox", value: true }];
  const page = await ensurePage();
  const checked = (label: string) => page.getByLabel(label, { exact: true }).isChecked();
  expect(((await session.execute("browser_fill_form", { fields })) as any).isError).toBe(false);
  expect(await page.getByLabel("Notes").inputValue()).toBe("Line one\nLine two");
  expect(await checked("Checked")).toBe(false);
  expect(await checked("Unchecked")).toBe(true);
  // Refilling is idempotent: a checkbox already in the requested state is not toggled.
  expect(((await session.execute("browser_fill_form", { fields })) as any).isError).toBe(false);
  expect(await checked("Checked")).toBe(false);
  const failed = await session.execute("browser_fill_form", { fields: [{ target: ref("Password"), name: "Password", type: "textbox", value: "dummy" }, { ...fields[0], value: "must not run" }] });
  expect((failed as any).isError).toBe(true);
  expect((failed.details as any).fields.map((f: any) => f.status)).toEqual(["failed", "not_attempted"]);
  expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe("Parity926");
  expect(await page.getByLabel("Password").inputValue()).toBe("");
  await expect(session.execute("browser_fill_form", { fields: [fields[0], fields[0]] })).rejects.toThrow("unique");
  await page.getByLabel("Name", { exact: true }).evaluate((node: any) => node.addEventListener("input", () => document.querySelector("textarea")!.remove(), { once: true }));
  const changed = await session.execute("browser_fill_form", { fields: [{ ...fields[0], value: "page changes" }, fields[1], fields[2]] });
  expect((changed.details as any).fields.map((f: any) => f.status)).toEqual(["filled", "failed", "not_attempted"]);
  await page.getByLabel("Name", { exact: true }).evaluate((node: any) => node.remove());
  await expect(session.execute("browser_fill_form", { fields: [fields[0]] })).rejects.toThrow("stale");
}), 30_000);

test("find validates queries, bounds context and times out pathological regex", async () => {
  for (const args of [{}, { text: "x", regex: "y" }, { regex: "[" }, { text: "" }, { text: "x", maxResults: 0 }])
    await expect(findPageLines([], args)).rejects.toThrow();
  const result = await findPageLines(["before", "Needle", "after", "needle"], { regex: "/needle/i", maxResults: 1 });
  expect(result.count).toBe(2); expect(result.truncated).toBe(true); expect(result.lines).toContain("1: before");
  // Engines may bound backtracking themselves; either no match or our timeout is valid.
  try { expect((await findPageLines(["a".repeat(10000) + "!"], { regex: "(a+)+$" })).count).toBe(0); }
  catch (error) { expect(String(error)).toContain("time limit"); }
});

realBrowserTest("find recovers generic text, shadow/frame content and actionable refs; typing rejects non-editable targets without clicking", () => withRealSession(async ({ session, serve, page: ensurePage }) => {
  const server = serve(`<html><body>
 <div>Scope of delivery</div><span>Original box and original papers</span>
 <div hidden>Hidden needle</div><div id="shadow"></div>
 <iframe srcdoc='<span>Frame needle</span><button>Frame action</button>'></iframe>
 <a href="/wrong">Navigate away</a><button onclick="document.title='clicked'">Load all listings</button>
 <input aria-label="Writable"><input aria-label="Read only" readonly><input aria-label="Password" type="password" value="secret-needle">
 <div contenteditable="true" aria-label="Editor">editable</div>
 <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<span>Shadow needle</span>';</script>
 </body></html>`);
  await session.execute("browser_navigate", { url: `http://127.0.0.1:${server.port}` });
  const found = text(await session.execute("browser_find", { regex: "/original|needle|Load all/i" }));
  for (const expected of ["Original box and original papers", "Scope of delivery", "Shadow needle", "Frame needle"]) expect(found).toContain(expected);
  expect(found).not.toContain("Hidden needle"); expect(found).not.toContain("secret-needle");
  await session.execute("browser_click", { target: refIn(found, "Load all"), element: "Load all" });
  const page = await ensurePage(); expect(await page.title()).toBe("clicked");
  let state = text(await session.execute("browser_snapshot", {}));
  for (const label of ["Navigate away", "Read only", "Load all"]) {
    await expect(session.execute("browser_type", { target: refIn(state, label), text: "wrong", submit: true })).rejects.toThrow("editable");
    expect(page.url()).toBe(`http://127.0.0.1:${server.port}/`);
  }
  await session.execute("browser_type", { target: refIn(state, "Writable"), text: "correct" });
  expect(await page.getByLabel("Writable").inputValue()).toBe("correct");
  state = text(await session.execute("browser_snapshot", {}));
  await session.execute("browser_type", { target: refIn(state, "Editor"), text: "replacement" });
  expect(await page.getByLabel("Editor").innerText()).toBe("replacement");
  const absent = await session.execute("browser_find", { text: "absent unique phrase" });
  expect(absent.details?.matches).toBe(0);
  expect(text(absent)).toContain('Query (text): "absent unique phrase"');
  expect(text(await session.execute("browser_find", { regex: "/missing-item/i" }))).toContain('Query (regex): "/missing-item/i"');
  (session as any).privateValues.add("private-search-value");
  expect(text(await session.execute("browser_find", { text: "private-search-value" }))).not.toContain("private-search-value");
  (session as any).privateValues.add('private\n"query"');
  expect(text(await session.execute("browser_find", { text: 'private\n"query"' }))).not.toContain("query");
  await page.evaluate(() => {
    const section = document.createElement("section");
    section.innerHTML = "<p>Ordinary row</p>".repeat(450) + "<div>Late needle <button>Late action</button></div>";
    document.body.append(section);
  });
  const late = text(await session.execute("browser_find", { text: "Late needle" }));
  expect(late).toContain("Late needle");
  expect(late).toContain("Late action");
}), 30_000);

realBrowserTest("hover reveals menu; console captures exceptions, bounds history and isolates tabs; snapshot marks non-editable controls", () => withRealSession(async ({ session, serve, page: ensurePage }) => {
  const server = serve(`<style>#menu{display:none}#hover:hover #menu{display:block}</style><div id="hover" aria-label="Hover area">Hover area<button id="menu">Revealed menu</button></div><div role="textbox" aria-label="Static editor">unchanged</div><input readonly aria-label="Read only"><div>DIV-RECEIPT <span>COUNT-1</span></div><pre>PRE-RECEIPT</pre><output>OUTPUT-RECEIPT</output><script>console.error('fixture-secret original error');setTimeout(()=>{throw new Error('fixture exception')},10)</script>`);
  session.registerPrivateValues(["fixture-secret"]);
  const state = text(await session.execute("browser_navigate", { url: `http://127.0.0.1:${server.port}` }));
  for (const receipt of ["DIV-RECEIPT", "COUNT-1", "PRE-RECEIPT", "OUTPUT-RECEIPT"]) expect(state).toContain(receipt);
  expect(state).toMatch(/Static editor.*non-editable/); expect(state).toMatch(/Read only.*readonly/);
  expect(text(await session.execute("browser_hover", { target: refIn(state, "Hover area") }))).toContain("Revealed menu");
  await session.execute("browser_hover", { target: "#hover" });
  await expect(session.execute("browser_hover", { target: "input,div" })).rejects.toThrow("exactly one");
  const page = await ensurePage();
  const consoleText = async (args: object) => text(await session.execute("browser_console_messages", args));
  await page.evaluate(() => { console.debug("debug-only"); console.info("info-message"); });
  await page.waitForTimeout(50);
  expect(await consoleText({})).not.toContain("debug-only");
  expect(await consoleText({ level: "debug" })).toContain("debug-only");
  const errors = await consoleText({ level: "error" });
  expect(errors).toContain("original error"); expect(errors).toContain("fixture exception"); expect(errors).toContain("http://127.0.0.1:"); expect(errors).not.toContain("fixture-secret");
  expect(await consoleText({})).toContain("fixture exception");
  await page.evaluate(() => { for (let i = 0; i < 250; i++) console.warn("entry-" + i); });
  await page.waitForTimeout(100);
  const bounded = await session.execute("browser_console_messages", { all: true });
  expect(bounded.details?.retained).toBe(200); expect(text(bounded)).not.toContain("entry-0\n"); expect(text(bounded)).toContain("entry-249");
  await session.execute("browser_navigate", { url: "about:blank" });
  expect(await consoleText({})).toBe("No matching console messages.");
  expect(await consoleText({ all: true })).toContain("entry-249");
  await session.execute("browser_tabs", { action: "new", url: "about:blank" });
  expect(await consoleText({ all: true })).toBe("No matching console messages.");
}), 30_000);

realBrowserTest("waits observe delayed visibility, visible duplicates, disappearance, timeout and cancellation without replaying actions", () => withRealSession(async ({ session, blank }) => {
  const page = await blank('<div id="status" style="display:none">READY926</div>');
  await page.evaluate(() => { setTimeout(() => { document.querySelector<HTMLElement>("#status")!.style.display = "block"; }, 150); });
  await session.execute("browser_wait_for", { text: "READY926" });
  await page.evaluate(() => { setTimeout(() => { document.querySelector<HTMLElement>("#status")!.remove(); }, 150); });
  await session.execute("browser_wait_for", { textGone: "READY926" });
  // A bare time returns as soon as the page is quiet, so a long time costs nothing on a quiet page.
  const started = Date.now(); await session.execute("browser_wait_for", { time: 10 }); expect(Date.now() - started).toBeLessThan(5000);
  // A hidden template must not make disappearance succeed while a live copy remains.
  await page.evaluate(() => { document.body.insertAdjacentHTML("beforeend", "<p hidden>STAYS926</p><p id=\"stays\">STAYS926</p>"); });
  await session.execute("browser_wait_for", { text: "STAYS926" });
  for (const args of [{ text: "NEVER926" }, { textGone: "STAYS926" }]) {
    const controller = new AbortController(); const start = Date.now();
    const pending = session.execute("browser_wait_for", args, controller.signal);
    setTimeout(() => controller.abort(new Error("New correction")), 150);
    await expect(pending).rejects.toThrow("New correction"); expect(Date.now() - start).toBeLessThan(2000);
    await session.execute("browser_snapshot", {});
  }
  await page.locator("#stays").evaluate((node: HTMLElement) => { node.hidden = true; });
  await session.execute("browser_wait_for", { textGone: "STAYS926" });
  await expect(session.execute("browser_wait_for", { text: "NEVER926" })).rejects.toThrow("Timed out after 10s");
  for (const args of [{ time: 11 }, { time: -1 }, { time: NaN }, { text: "" }]) await expect(session.execute("browser_wait_for", args)).rejects.toThrow();
}), 30_000);
