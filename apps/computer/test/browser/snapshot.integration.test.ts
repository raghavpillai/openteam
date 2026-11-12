// What browser_snapshot exposes on real pages: roles, states, values, refs and
// private-value redaction, and how refs live across observations.
import { expect } from "bun:test";
import type { UserForm } from "@openteam/contracts";
import { snapshotAcrossFrames, frameRefsByPage } from "../../src/browser/reference-driver";
import { realBrowserTest, refIn, text, withRealSession } from "./real-browser";

const lineOf = (snapshot: string, name: string) => snapshot.split("\n").find((line) => line.includes(name))!;

realBrowserTest("ARIA control states remain observable before and after clicks", () => withRealSession(async ({ session, blank }) => {
  const page = await blank(`<button aria-pressed="false" onclick="this.setAttribute('aria-pressed',this.getAttribute('aria-pressed')==='true'?'false':'true')">Pin item</button>
   <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Show details</button>
   <div role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">History</button></div>
   <div role="checkbox" aria-label="Include archived" aria-checked="mixed" tabindex="0"></div>
   <input type="checkbox" aria-label="Native checked" checked><input id="mixed" type="checkbox" aria-label="Native mixed">
   <button aria-pressed="mixed">Mixed toggle</button>
   <div role="checkbox" aria-label="Not checked" aria-checked="false" tabindex="0"></div>
   <style>[role=checkbox]{width:20px;height:20px}</style>`);
  await page.locator("#mixed").evaluate((el: HTMLInputElement) => { el.indeterminate = true; });
  const before = text(await session.execute("browser_snapshot", {}));
  for (const [name, state] of [['"Pin item"', "pressed=false"], ['"Show details"', "expanded=false"], ['"Overview"', "selected=true"],
    ['"History"', "selected=false"], ['"Include archived"', "checked=mixed"], ['"Not checked"', "checked=false"],
    ['"Native checked"', "checked"], ['"Native mixed"', "checked=mixed"], ['"Mixed toggle"', "pressed=mixed"]])
    expect(lineOf(before, name!)).toContain(state!);
  await session.execute("browser_click", { ref: refIn(before, '"Pin item"'), element: "Pin item" });
  await session.execute("browser_click", { ref: refIn(before, '"Show details"'), element: "Show details" });
  const after = text(await session.execute("browser_snapshot", {}));
  expect(lineOf(after, '"Pin item"')).toContain("pressed=true");
  expect(lineOf(after, '"Show details"')).toContain("expanded=true");
}), 30_000);

realBrowserTest("custom and native range values expose transitions, bounds and private-value redaction", () => withRealSession(async ({ session, blank }) => {
  const page = await blank(`<div role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40" aria-valuetext="40 percent" onkeydown="if(event.key==='ArrowRight'){this.setAttribute('aria-valuenow','50');this.setAttribute('aria-valuetext','50 percent')}">Volume</div>
   <div role="spinbutton" tabindex="0" aria-label="Quantity" aria-valuenow="3" aria-valuemin="1" aria-valuemax="10">Quantity</div>
   <div role="slider" tabindex="0" aria-label="Invalid" aria-valuenow="unknown" aria-valuemin="" aria-valuemax="Infinity">Invalid</div>
   <div role="slider" tabindex="0" aria-label="Private" data-sand-secret-filled="true" aria-valuenow="7391" aria-valuetext="private sentinel">Private</div>
   <input type="range" aria-label="Native volume" value="30" min="10" max="90" step="5">
   <input type="number" aria-label="Native quantity" value="3" min="1" max="12" step="1">
   <input type="number" aria-label="Continuous" value="0.5" min="-2.5" max="1e2" step="any">
   <input type="range" aria-label="Native invalid" min="" max="Infinity" step="0">
   <input type="number" aria-label="Malformed" min="0x10" max="0b11" step="-5">
   <input type="range" aria-label="Implicit defaults">
   <input type="number" aria-label="Private bounds" data-sand-secret-filled="true" value="7392" min="7380" max="7400" step="2">`);
  const line = (snapshot: string, name: string) => lineOf(snapshot, JSON.stringify(name));
  const before = text(await session.execute("browser_snapshot", {}));
  for (const part of ['valuenow="40"', 'valuemin="0"', 'valuemax="100"', 'valuetext="40 percent"']) expect(line(before, "Volume")).toContain(part);
  expect(line(before, "Quantity")).toContain('valuenow="3"');
  expect(line(before, "Invalid")).not.toMatch(/value(now|min|max)=/);
  expect(before).toContain('valuetext="<redacted>"');
  expect(line(before, "Native volume")).toContain('value="30"');
  expect(line(before, "Native volume")).toContain('min="10" max="90" step="5"');
  expect(line(before, "Native quantity")).toContain('min="1" max="12" step="1"');
  expect(line(before, "Continuous")).toContain('min="-2.5" max="1e2" step="any"');
  for (const name of ["Native invalid", "Malformed", "Implicit defaults"]) expect(line(before, name)).not.toMatch(/ (min|max|step)=/);
  for (const secret of ["7391", "private sentinel", "7392", "7380", "7400"]) expect(before).not.toContain(secret);
  expect(line(before, "Private bounds")).toContain('min="<redacted>" max="<redacted>" step="<redacted>"');
  await page.getByRole("slider", { name: "Volume", exact: true }).press("ArrowRight");
  await page.getByRole("slider", { name: "Native volume", exact: true }).press("ArrowRight");
  const after = text(await session.execute("browser_snapshot", {}));
  expect(line(after, "Volume")).toContain('valuenow="50"');
  expect(line(after, "Volume")).toContain('valuetext="50 percent"');
  expect(line(after, "Native volume")).toContain('value="35"');
  expect(line(after, "Native volume")).toContain('min="10" max="90" step="5"');
}), 30_000);

realBrowserTest("SVG controls remain discoverable and actionable", () => withRealSession(async ({ session, blank }) => {
  const page = await blank(`<svg width="400" height="240" xmlns="http://www.w3.org/2000/svg">
   <g role="button" aria-label="Expand diagram" tabindex="0" onclick="document.title='expanded'"><rect x="10" y="10" width="120" height="40" fill="blue"/></g>
   <a href="#details"><text x="10" y="100">Diagram details</text></a>
   <g role="button" aria-label="Unavailable action" aria-disabled="true"><rect x="150" y="10" width="100" height="40"/></g>
   <g role="button" aria-label="Hidden diagram action" style="display:none"><rect width="100" height="40"/></g>
   <foreignObject x="10" y="130" width="200" height="60"><button xmlns="http://www.w3.org/1999/xhtml" onclick="document.title='embedded'">Embedded HTML action</button></foreignObject>
  </svg>`);
  const snapshot = text(await session.execute("browser_snapshot", {}));
  expect(lineOf(snapshot, "Unavailable action")).toContain("disabled");
  expect(lineOf(snapshot, "Unavailable action")).not.toContain("[ref=");
  expect(snapshot).not.toContain("Hidden diagram action");
  await session.execute("browser_click", { ref: refIn(snapshot, 'button "Expand diagram"'), element: "Expand diagram" });
  expect(await page.title()).toBe("expanded");
  await session.execute("browser_click", { ref: refIn(snapshot, 'button "Embedded HTML action"'), element: "Embedded HTML action" });
  expect(await page.title()).toBe("embedded");
  await session.execute("browser_click", { ref: refIn(snapshot, 'link "Diagram details"'), element: "Diagram details" });
  expect(await page.evaluate(() => location.hash)).toBe("#details");
}), 30_000);

realBrowserTest("textarea snapshots preserve line boundaries with bounded, redacted values", () => withRealSession(async ({ session, serve, page }) => {
  const server = serve('<textarea aria-label="Multiline"></textarea><textarea aria-label="Long"></textarea><textarea aria-label="Private" data-sand-secret-filled></textarea><textarea aria-label="Registered"></textarea>');
  await session.execute("browser_navigate", { url: server.url.origin });
  const live = await page();
  const value = "First  line\n\nCafé 東京\nFinal line with enough text to exceed forty characters";
  await live.getByLabel("Multiline").fill(value);
  await live.getByLabel("Long", { exact: true }).fill("x".repeat(2100));
  await live.getByLabel("Private", { exact: true }).fill("synthetic private text\nsecond line");
  session.registerPrivateValues(["registered-secret-fixture"]);
  await live.getByLabel("Registered", { exact: true }).fill("registered-secret-fixture");
  const snapshot = text(await session.execute("browser_snapshot", {}));
  expect(snapshot).toContain("value=" + JSON.stringify(value));
  expect(snapshot).toContain("value=" + JSON.stringify("x".repeat(2000)) + " value-truncated");
  expect(snapshot).not.toContain("x".repeat(2001));
  expect(snapshot).not.toContain("synthetic private text");
  expect(snapshot).not.toContain("registered-secret-fixture");
  expect(snapshot).toContain('value="<redacted>"');
  expect(snapshot).toContain('value="[REDACTED]"');
}), 30_000);

realBrowserTest("snapshots expose native dropdown choices and selections, and select options by label", () => withRealSession(async ({ session, serve, page }) => {
  const server = serve(`<!doctype html>
    <label>Priority <select id="priority"><option>One</option><option selected>Two</option><option disabled>Three</option><option hidden>Hidden choice</option></select></label>
    <label>Languages <select multiple><optgroup label="Available"><option selected>Café</option><option selected>日本語</option></optgroup><optgroup label="Unavailable" disabled><option>Latin</option></optgroup><optgroup label="Hidden" hidden><option>Invisible</option></optgroup></select></label>
    <select aria-label="Hidden control" hidden><option>Never visible</option></select>
    <select aria-label="Private choice" data-sand-secret-filled><option selected>private-value</option></select>
    <button>Submit</button>`);
  await session.execute("browser_navigate", { url: server.url.origin });
  let snapshot = text(await session.execute("browser_snapshot", {}));
  for (const option of ['- option "One"', '- option "Two" selected', '- option "Three" disabled', '- option "Café" selected', '- option "日本語" selected', '- option "Latin" disabled'])
    expect(snapshot).toContain(option);
  expect(snapshot).not.toMatch(/- option "(?:Hidden choice|Invisible|Never visible)"/);
  expect(snapshot).not.toContain("private-value");
  const ref = refIn(snapshot, 'combobox "Priority');
  await session.execute("browser_select_option", { ref, element: "Priority", values: ["One"] });
  snapshot = text(await session.execute("browser_snapshot", {}));
  expect(snapshot).toContain('- option "One" selected');
  expect(snapshot).not.toContain('- option "Two" selected');
  expect(refIn(snapshot, 'combobox "Priority')).toBe(ref);
  const live = await page();
  await live.evaluate(() => {
    const el = document.createElement("select");
    el.setAttribute("aria-label", "Collision");
    el.innerHTML = '<option value="first">second</option><option value="second">Other choice</option>';
    document.body.append(el);
    const grouped = document.createElement("select");
    grouped.setAttribute("aria-label", "Grouped");
    grouped.innerHTML = '<optgroup disabled><option value="locked">Choice</option></optgroup><option value="available">Choice</option>';
    document.body.append(grouped);
  });
  snapshot = text(await session.execute("browser_snapshot", {}));
  await session.execute("browser_select_option", { ref: refIn(snapshot, 'combobox "Collision'), values: ["second"] });
  expect(await live.getByLabel("Collision").inputValue()).toBe("second");
  await session.execute("browser_select_option", { ref: refIn(snapshot, 'combobox "Grouped'), values: ["Choice"] });
  expect(await live.getByLabel("Grouped").inputValue()).toBe("available");
  const shallow = text(await session.execute("browser_snapshot", { maxDepth: 0 }));
  expect(shallow).toContain('combobox "Priority');
  expect(shallow).not.toContain('- option "One"');
  await live.setContent('<select aria-label="Large menu">' + Array.from({ length: 1000 }, (_, i) => `<option>Choice ${i}</option>`).join("") + "</select>");
  const bounded = text(await session.execute("browser_snapshot", {}));
  expect(bounded.match(/- option /g)?.length).toBeLessThanOrEqual(399);
  expect(bounded).toContain("snapshot truncated");
}), 60_000);

realBrowserTest("delegated click containers retain independently actionable descendants", () => withRealSession(async ({ session, blank }) => {
  const page = await blank(`<div onclick="void 0"><ul role="tablist"><li role="presentation" onclick="void 0"><a role="tab" href="#specs" onclick="document.title='specifications'">Specifications</a></li><li onclick="void 0"><a role="tab" href="#compat">Compatibility</a></li></ul></div><section onclick="void 0"><label>Quantity<input aria-label="Quantity"></label><button onclick="document.title='saved'">Save row</button><button hidden>Hidden action</button></section>`);
  await page.evaluate(() => {
    const host = document.createElement("div"); host.setAttribute("onclick", "void 0"); host.style.display = "block";
    host.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow action</button>"; document.body.append(host);
    const outer = document.createElement("section"); outer.setAttribute("onclick", "void 0"); const inner = document.createElement("div");
    inner.attachShadow({ mode: "open" }).innerHTML = "<button onclick=\"document.title='nested-shadow'\">Nested shadow action</button>"; outer.append(inner); document.body.append(outer);
    const paragraph = document.createElement("p"); paragraph.textContent = "Account controls "; const widget = document.createElement("span");
    widget.attachShadow({ mode: "open" }).innerHTML = "<button>Nested paragraph action</button>"; paragraph.append(widget); document.body.append(paragraph);
    const wrapper = document.createElement("div"); wrapper.setAttribute("onclick", "void 0");
    wrapper.innerHTML = '<iframe srcdoc="<button>Frame action</button>"></iframe>'; document.body.append(wrapper);
  });
  await page.frameLocator("iframe").getByRole("button", { name: "Frame action" }).waitFor();
  const snapshot = text(await session.execute("browser_snapshot", {}));
  for (const name of ['tab "Compatibility"', 'textbox "Quantity"', 'button "Save row"', 'button "Shadow action"', 'button "Frame action"', 'button "Nested paragraph action"'])
    expect(refIn(snapshot, name)).toBeDefined();
  expect(snapshot).not.toContain("Hidden action");
  await session.execute("browser_click", { ref: refIn(snapshot, 'button "Nested shadow action"'), element: "Nested shadow action" });
  expect(await page.title()).toBe("nested-shadow");
  await session.execute("browser_click", { ref: refIn(snapshot, 'tab "Specifications"'), element: "Specifications" });
  expect(await page.title()).toBe("specifications");
}), 30_000);

realBrowserTest("visible labels expose refs and checked state for styled native toggles and hidden file inputs", () => withRealSession(async ({ session, serve, page }) => {
  const server = serve(`<!doctype html><style>input[type=radio]{display:none}</style>
    <input type="radio" name="period" id="short" checked><label for="short">Short period</label>
    <input type="radio" name="period" id="long"><label for="long">Long period</label>
    <input type="radio" id="locked" disabled><label for="locked">Unavailable</label>
    <label>Include extras<input type="checkbox"></label><label>Ordinary text</label>
    <label hidden><input type="checkbox">Hidden option</label>
    <label>Import CSV<input id="upload" type="file" style="display:none"></label>
    <input id="second-upload" type="file" style="display:none">
    <label for="second-upload">Second upload</label>
    <label>Disabled upload<input type="file" disabled style="display:none"></label>`);
  let snapshot = text(await session.execute("browser_navigate", { url: server.url.href }));
  const line = (name: string) => snapshot.split("\n").find((s) => s.includes(`label "${name}"`)) ?? "";
  expect(line("Short period")).toMatch(/\[ref=e\d+\].*checked/);
  const ref = line("Long period").match(/\[ref=(e\d+)\]/)?.[1];
  expect(ref).toBeDefined();
  for (const name of ["Unavailable", "Disabled upload"]) { expect(line(name)).toContain("disabled"); expect(line(name)).not.toContain("[ref="); }
  expect(line("Ordinary text")).not.toContain("[ref=");
  expect(snapshot).not.toContain("Hidden option");
  expect(snapshot).toContain('checkbox "Include extras"');
  const uploadRef = line("Import CSV").match(/\[ref=(e\d+)\]/)?.[1];
  expect(uploadRef).toBeDefined();
  expect(line("Second upload")).toMatch(/\[ref=e\d+\]/);
  const observed = await session.fileInputReviewTarget({ ref: uploadRef });
  expect(observed?.observation.target.type).toBe("file");
  await observed!.validate();
  const live = await page();
  const importLabel = live.locator("label").filter({ hasText: "Import CSV" });
  await importLabel.evaluate((label: HTMLLabelElement) => label.htmlFor = "second-upload");
  await expect(observed!.validate()).rejects.toThrow("changed");
  await observed!.dispose();
  await importLabel.evaluate((label: HTMLLabelElement) => label.removeAttribute("for"));

  await session.execute("browser_click", { ref, element: "Long period" });
  snapshot = text(await session.execute("browser_snapshot", {}));
  expect(line("Long period")).toContain("checked");
  expect(line("Short period")).not.toContain("checked");
  expect(await live.locator("#long").isChecked()).toBe(true);
  const pickerEvent = live.waitForEvent("filechooser");
  await session.execute("browser_click", { ref: line("Import CSV").match(/\[ref=(e\d+)\]/)?.[1], element: "Import CSV" });
  const picker = await pickerEvent;
  expect(await picker.element().getAttribute("id")).toBe("upload");
  await picker.setFiles([]);
}), 60_000);

realBrowserTest("snapshot exposes focusable hover containers and inherited disabled state without hiding child controls", () => withRealSession(async ({ session, blank }) => {
  await blank(`<style>#menu{display:none}#hover:hover #menu{display:block}</style>
   <div id="hover" tabindex="0">Reviewer actions<div id="menu"><button onclick="document.querySelector('fieldset').disabled=false">Unlock form</button></div></div>
   <div tabindex="0"><div contenteditable="true" data-sand-secret-filled>focusable-private-value</div></div>
   <fieldset disabled><legend><input aria-label="Legend exception"></legend><label>Recipient<input></label><select aria-label="Region"><option>Europe</option></select></fieldset>`);
  session.registerPrivateValues(["focusable-private-value"]);
  const state = text(await session.execute("browser_snapshot", {}));
  expect(state).not.toContain("focusable-private-value");
  expect(state).toMatch(/Reviewer actions.*\[ref=e\d+\]/);
  expect(state).toMatch(/Recipient" disabled/);
  expect(state).toMatch(/Region.*disabled/);
  expect(state).toMatch(/Legend exception.*\[ref=e\d+\]/);
  expect(state).not.toContain("Unlock form");
  const hovered = text(await session.execute("browser_hover", { target: refIn(state, "Reviewer actions") }));
  const unlocked = text(await session.execute("browser_click", { ref: refIn(hovered, 'button "Unlock form"') }));
  expect(unlocked).toMatch(/Recipient.*\[ref=e\d+\]/);
  expect(unlocked).not.toMatch(/Recipient.*disabled/);
}), 30_000);

realBrowserTest("DOM observations supply actionable refs, preserve private text masking, and allow explicit images", () => withRealSession(async ({ session, serve }) => {
  const server = serve('<!doctype html><label>Name <input aria-label="Name"></label><input type="password" value="hidden-password"><button onclick="this.textContent=\'Saved\'">Save</button>');
  for (const mode of ["image", "dom"] as const) {
    session.configureObservationMode(mode);
    const result = await session.execute("browser_navigate", { url: server.url.href });
    const state = mode === "image" ? await session.execute("browser_snapshot", {}) : result;
    const clicked = await session.execute("browser_click", { target: refIn(text(state), '"Save"'), element: "Save" });
    const final = mode === "image" ? await session.execute("browser_snapshot", {}) : clicked;
    expect(text(final)).toContain('"Saved"');
    expect(text(final)).not.toContain("hidden-password");
    expect(result.content.some((c) => c.type === "image")).toBe(mode === "image");
    if (mode === "dom") expect(final.content.some((c) => c.type === "image")).toBe(false);
  }
  expect(text(await session.execute("browser_snapshot", {}))).toContain('"Saved"');
  const image = await session.execute("browser_take_screenshot", {});
  expect(image.content.some((c) => c.type === "image")).toBe(true);
  expect(image.details?.path).toBeTruthy();
  expect(text(await session.execute("browser_tabs", { action: "list" }))).toContain("- 0: (current) [");
  await session.execute("browser_tabs", { action: "new" });
  await session.execute("browser_tabs", { action: "select", index: 0 });
  const targeted = await session.execute("browser_take_screenshot", {});
  expect(targeted.details?.url).toBe(server.url.href);
  expect(targeted.content.some((c) => c.type === "image")).toBe(true);
}), 90_000);

realBrowserTest("stable refs survive find and scoped observations, retire on navigation, and upgrade live positional documents", () => withRealSession(async ({ session, context, serve, page: ensurePage }) => {
  const child = serve('<button id="child">Child button</button>', "0.0.0.0");
  const server = serve(`<button id="main">Main button</button><div id="recovery"></div><label for="otp">Enter verification code</label><input id="otp" autocomplete="one-time-code"><iframe src="http://localhost:${child.port}"></iframe>`);
  const internal = session as any;
  const page = await ensurePage();
  await page.goto(server.url.origin);
  const positional = await snapshotAcrossFrames(context, page, { stableRefs: false, maxDepth: 20 });
  frameRefsByPage.set(page, positional.refOwners);
  const old = refIn(positional.lines.join("\n"), 'button "Main button"');
  await session.execute("browser_snapshot", {});
  await expect(internal.requireRef(page, old)).rejects.toThrow("stale");
  const capture = (await internal.captureSnapshot(page)).lines.join("\n");
  const current = refIn(capture, 'button "Main button"');
  expect(current).not.toBe(old);
  expect(await (await internal.requireRef(page, current)).getAttribute("id")).toBe("main");
  const childRef = refIn(capture, 'button "Child button"');
  await session.execute("browser_snapshot", { selector: "#main" });
  expect(await (await internal.requireRef(page, childRef)).getAttribute("id")).toBe("child");
  // A new editable control before the OTP would receive its old positional
  // ref. Check the actual destination, including a previously prepared form.
  const form: UserForm = { title: "Code", instruction: "Synthetic fixture", domain: "127.0.0.1",
    fields: [{ id: "otp", label: "Verification code", type: "otp", target: { kind: "ref", value: refIn(capture, 'textbox "Enter verification code"') } }] };
  const binding = (await session.formPages(form.domain!))[0]!;
  await session.prepareForm(binding, form);
  await page.locator("#recovery").evaluate((node: HTMLElement) => {
    node.innerHTML = '<a href="#help">Recovery</a><input id="decoy" aria-label="Other code">';
  });
  await session.execute("browser_find", { text: "verification code" });
  expect(await session.fillForm(binding, form.fields[0]!, "246810")).toBe(true);
  expect(await page.locator("#otp").inputValue()).toBe("246810");
  expect(await page.locator("#decoy").inputValue()).toBe("");
  expect((await session.prepareForm((await session.formPages(form.domain!))[0]!, form)).reachable).toEqual(["otp"]);
  await page.reload();
  await session.execute("browser_snapshot", {});
  await expect(internal.requireRef(page, current)).rejects.toThrow("stale");
  await expect(internal.requireRef(page, childRef)).rejects.toThrow("stale");
}, ["--no-sandbox"]), 60_000);
