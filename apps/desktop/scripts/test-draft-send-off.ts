/** Tries to break the draft cards' send-off and discard the way a user could:
    leaving the chat mid-send, failures, double clicks, another device, a window
    that goes inactive. Runs every story against the email and Messages cards. */
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../computer/node_modules/playwright-core/index.mjs";

const only = process.argv[2] ?? "";
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false, hmr: false },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
type Look = {
  fx: string; status: string; summary: string; alert: string; layer: boolean; animations: number;
  actor: [number, number] | null; height: number; layoutHeight: number; closesFrom: number | null; requests: number;
  buttons: { text: string; seen: boolean; clickable: boolean }[];
};
type Story = Awaited<ReturnType<typeof tools>>;
const results: { story: string; ok: boolean; problems: string[] }[] = [];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function tools(page: import("../../computer/node_modules/playwright-core").Page, problems: string[]) {
  const qa = <T,>(run: string, value?: unknown) => page.evaluate(`(${run})(${JSON.stringify(value ?? null)})`) as Promise<T>;
  const api = {
    page,
    look: () => qa<Look>("() => window.draftSendOffQA.look()"),
    trace: () => qa<string>("() => window.draftSendOffQA.control.trace.join('>')"),
    // How long the blob waited before the flight began, on the page's own clock.
    held: () => qa<number>("() => window.draftSendOffQA.control.times.flying - window.draftSendOffQA.control.times.charging"),
    send: () => qa("() => document.querySelector('.draft-button-primary').click()"),
    click: (text: string) => qa("(wanted) => [...document.querySelectorAll('.draft-card button')].find((button) => button.textContent.trim().startsWith(wanted))?.click()", text),
    twice: (text: string) => qa("(wanted) => { const button = [...document.querySelectorAll('.draft-card button')].find((item) => item.textContent.trim() === wanted); button.click(); button.click(); }", text),
    escape: () => qa("() => document.querySelector('.draft-card').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"),
    leave: () => qa("() => window.draftSendOffQA.leave()"),
    back: () => qa("() => window.draftSendOffQA.back()"),
    remote: (state: string) => qa("(state) => window.draftSendOffQA.remote(state)", state),
    edges: (ms: number) => qa<[number, number][]>("(ms) => window.draftSendOffQA.edges(ms)", ms),
    set: (patch: Record<string, unknown>) => qa("(values) => Object.assign(window.draftSendOffQA.control, values)", patch),
    expect(what: string, ok: unknown, detail?: unknown) {
      if (!ok) problems.push(`${what}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
    },
    async until(what: string, test: (seen: Look) => unknown, timeout = 8000) {
      const start = Date.now();
      for (;;) {
        const seen = await api.look();
        if (test(seen)) return seen;
        if (Date.now() - start > timeout) {
          problems.push(`never: ${what}: ${JSON.stringify(seen)}`);
          return seen;
        }
        await sleep(40);
      }
    },
    button: (seen: Look, text: string) => seen.buttons?.find((button) => button.text.startsWith(text)),
    // The settled receipt, with nothing of the send-off left behind.
    async sent() {
      await api.until("settled as Sent", (now) => now.status === "Sent" && now.summary.startsWith("Sent to") && !now.layer && now.fx !== "flying" && now.fx !== "charging");
      await sleep(250);
      const after = await api.look();
      api.expect("no Send button on the receipt", !api.button(after, "Send"), after.buttons);
      api.expect("no send-off animation still running", after.animations === 0, after.animations);
      return after;
    },
    // Back to a draft the user can act on.
    async pending() {
      const seen = await api.until("back to a pressable Send", (now) => now.fx === "" && api.button(now, "Send")?.seen && api.button(now, "Send")?.clickable && api.button(now, "Discard")?.seen && api.button(now, "Discard")?.clickable);
      api.expect("no send-off layer left", !seen.layer);
      return seen;
    },
  };
  return api;
}

async function story(name: string, kind: string, query: string, body: (t: Story) => Promise<void>, context: { reducedMotion?: "reduce" } = {}) {
  const label = `${kind}: ${name}`;
  if (only && !label.includes(only)) return;
  const browserContext = await browser.newContext({ viewport: { width: 640, height: 560 }, ...context });
  const page = await browserContext.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const problems: string[] = [];
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}test/browser/draft-send-off.html?${kind === "imessage" ? "card=imessage&" : ""}${query}`);
    await page.waitForFunction("Boolean(window.draftSendOffQA)");
    await sleep(500);
    await body(tools(page, problems));
  } catch (error) {
    problems.push(`threw: ${(error as Error).message}`);
  }
  for (const error of errors) problems.push(`page error: ${error}`);
  results.push({ story: label, ok: problems.length === 0, problems });
  console.log(`${problems.length ? "FAIL" : "ok  "} ${label}${problems.length ? `\n     ${problems.join("\n     ")}` : ""}`);
  await browserContext.close();
}

const waitingLooksRight = async (t: Story, what: string) => {
  const seen = await t.look();
  t.expect(`${what}: card is waiting`, seen.fx === "charging", seen.fx);
  t.expect(`${what}: Send can't be pressed again`, !t.button(seen, "Send")?.clickable, seen.buttons);
  for (const other of seen.buttons.filter((button) => !button.text.startsWith("Send") && !button.text.startsWith("Show")))
    t.expect(`${what}: "${other.text}" can't be clicked while hidden`, !other.clickable, other);
  return seen;
};

try {
  for (const kind of ["email", "imessage"]) {
    let receipt: Look | undefined;
    await story("another device sends it (no send-off here)", kind, "", async (t) => {
      await t.remote("sent");
      receipt = await t.sent();
      t.expect("no send-off played", !(await t.trace()).includes("flying"), await t.trace());
    });
    await story("plain send", kind, "latency=1500", async (t) => {
      await t.send();
      await sleep(400);
      const blob = await waitingLooksRight(t, "400 ms in");
      t.expect("the gathered button is a 32px circle", blob.actor && Math.abs(blob.actor[0] - 32) < 2.5 && Math.abs(blob.actor[1] - 32) < 2.5, blob.actor);
      const seen = await t.sent();
      t.expect("one request", seen.requests === 1, seen.requests);
      t.expect("send-off played once", (await t.trace()) === "charging>flying>landed", await t.trace());
      if (receipt) t.expect("same height as the card from history", seen.height === receipt.height, [seen.height, receipt.height]);
    });
    await story("double-click Send", kind, "", async (t) => {
      await t.twice("Send");
      await sleep(150);
      await t.send();
      const seen = await t.sent();
      t.expect("one request", seen.requests === 1, seen.requests);
    });
    await story("instant answer still shows the blob", kind, "latency=0", async (t) => {
      await t.send();
      await t.sent();
      t.expect("the blob was held for its minimum", (await t.held()) >= 290, await t.held());
    });
    await story("request throws, then retry works", kind, "fail", async (t) => {
      await t.send();
      const seen = await t.pending();
      t.expect("an error is shown", seen.alert.length > 0, seen.alert);
      await t.set({ fail: false });
      await t.send();
      const after = await t.sent();
      t.expect("two requests", after.requests === 2, after.requests);
    });
    await story("server answers with a send error", kind, "senderror", async (t) => {
      await t.send();
      const seen = await t.pending();
      t.expect("the error is shown", seen.alert.includes("refused"), seen.alert);
    });
    await story("leave while waiting, back before the answer", kind, "latency=2500", async (t) => {
      await t.send();
      await sleep(400);
      await t.leave();
      await sleep(600);
      await t.back();
      await sleep(120);
      await waitingLooksRight(t, "on return");
      const seen = await t.sent();
      t.expect("one request", seen.requests === 1, seen.requests);
      t.expect("send-off played after returning", (await t.trace()).endsWith("charging>flying>landed"), await t.trace());
    });
    await story("leave and come straight back, before the server's claim arrives", kind, "latency=2500", async (t) => {
      await t.send();
      await sleep(10);
      await t.leave();
      await sleep(15);
      await t.back();
      await sleep(10);
      await waitingLooksRight(t, "on return");
      await t.sent();
    });
    await story("leave while waiting, back after the answer", kind, "", async (t) => {
      await t.send();
      await sleep(400);
      await t.leave();
      await sleep(1300);
      await t.back();
      await sleep(60);
      const seen = await t.look();
      t.expect("already the receipt on return", seen.status === "Sent" && seen.fx !== "charging" && seen.fx !== "flying", seen);
      await t.sent();
      t.expect("no send-off replayed", !(await t.trace()).includes("flying"), await t.trace());
    });
    await story("leave during the send-off itself", kind, "", async (t) => {
      await t.send();
      await t.until("flying", (now) => now.fx === "flying");
      await sleep(350);
      await t.leave();
      await sleep(300);
      await t.back();
      await sleep(60);
      const seen = await t.look();
      t.expect("the receipt on return", seen.status === "Sent" && seen.fx !== "flying", seen);
      await t.sent();
    });
    await story("leave, the request throws while away, back before it does", kind, "latency=2000&fail", async (t) => {
      await t.send();
      await sleep(400);
      await t.leave();
      await sleep(400);
      await t.back();
      await sleep(120);
      await waitingLooksRight(t, "on return");
      await t.pending();
    });
    await story("leave, the server answers with a send error, back before it does", kind, "latency=2000&senderror", async (t) => {
      await t.send();
      await sleep(400);
      await t.leave();
      await sleep(400);
      await t.back();
      const seen = await t.pending();
      t.expect("the error is shown", seen.alert.includes("refused"), seen.alert);
    });
    await story("leave, answered, but the card can't re-read it (offline)", kind, "latency=2000&pushlag=60000", async (t) => {
      await t.send();
      await sleep(400);
      await t.leave();
      await t.set({ failRefresh: true });
      await sleep(400);
      await t.back();
      await sleep(2200);
      const seen = await t.look();
      // The store still says "sending" and the card couldn't ask: it must not sit on a bare blob.
      t.expect("not a bare blob forever", seen.fx === "", seen);
      if (kind === "email") t.expect("offers Check delivery", Boolean(t.button(seen, "Check delivery")?.seen), seen.buttons);
      else t.expect("says it is sending", Boolean(t.button(seen, "Sending")?.seen), seen.buttons);
      t.expect("Send can't be pressed while the server says sending", !t.button(seen, "Send")?.clickable, seen.buttons);
    });
    await story("store lags the answer; leave and return right after the send-off", kind, "pushlag=1500", async (t) => {
      await t.send();
      await t.sent();
      await t.leave();
      await sleep(50);
      await t.back();
      await sleep(80);
      const seen = await t.look();
      t.expect("Send can't be pressed again", !t.button(seen, "Send")?.clickable, seen);
      await t.sent();
      t.expect("one request", (await t.look()).requests === 1);
    });
    await story("another device's Sent arrives before this request returns", kind, "latency=3000", async (t) => {
      await t.send();
      await sleep(500);
      await t.remote("sent");
      await t.sent();
      await sleep(2800);
      const seen = await t.sent();
      t.expect("send-off played once", (await t.trace()) === "charging>flying>landed", await t.trace());
      t.expect("one request", seen.requests === 1, seen.requests);
    });
    await story("window goes inactive while waiting", kind, "", async (t) => {
      await t.send();
      await sleep(150);
      await t.page.evaluate("document.documentElement.dataset.windowInactive = ''");
      await t.sent();
    });
    await story("window resized during the send-off", kind, "", async (t) => {
      await t.send();
      await t.until("flying", (now) => now.fx === "flying");
      await sleep(200);
      await t.page.setViewportSize({ width: 420, height: 700 });
      await t.sent();
    });
    for (const button of ["Send", "Discard"]) {
      await story(`${button} while the row is still scaled by its entrance`, kind, "scaled", async (t) => {
        const before = await t.look();
        await t.click(button);
        const flying = await t.until("flying", (now) => now.fx === "flying" && now.closesFrom !== null);
        t.expect("the card closes from its real height, not its scaled one", Math.abs((flying.closesFrom ?? 0) - before.layoutHeight) < 1, [flying.closesFrom, before.layoutHeight]);
        await t.until("settled", (now) => now.status === (button === "Send" ? "Sent" : "Discarded") && !now.layer && now.fx !== "flying");
      });
      // The chat applies a row's new height a frame late. Held at its bottom, it
      // then slides down by what the card gave up; the card's bottom edge, which
      // the blob rides, must already be there and not lift off while it catches up.
      const settled = async (t: Story) => {
        await t.until("settled", (now) => now.status === (button === "Send" ? "Sent" : "Discarded") && !now.layer && now.fx !== "flying");
        await sleep(250);
        return (await t.edges(60)).at(-1)!;
      };
      for (const when of ["task", "frame"])
        await story(`${button} at the bottom of a long chat that re-measures a frame late (in a ${when})`, kind, `list=${when}`, async (t) => {
          await t.click(button);
          await t.until("flying", (now) => now.fx === "flying");
          const edges = await t.edges(900);
          const drift = Math.max(...edges.map(([, bottom]) => Math.abs(bottom - edges[0]![1])));
          // Its own kick moves it a couple of pixels; a lagging list would lift it by tens.
          t.expect("the card's bottom edge stays put while it closes", drift <= 5, Math.round(drift * 10) / 10);
          t.expect("and is in the same place afterwards", Math.abs((await settled(t))[1] - edges[0]![1]) <= 2);
        });
      // A chat too short to scroll has no bottom to be held at: the card closes
      // upward, under the message above it, and must not slide down and jump back.
      await story(`${button} in a chat too short to scroll`, kind, "list=task&above=40", async (t) => {
        await t.click(button);
        await t.until("flying", (now) => now.fx === "flying");
        const edges = await t.edges(900);
        const drift = Math.max(...edges.map(([top]) => Math.abs(top - edges[0]![0])));
        t.expect("the card's top edge stays put while it closes", drift <= 5, Math.round(drift * 10) / 10);
        t.expect("and is in the same place afterwards", Math.abs((await settled(t))[0] - edges[0]![0]) <= 2);
      });
      // With less scroll than the card gives up, the chat slides down only as far
      // as it can. The card must end the flight where it will settle.
      await story(`${button} in a chat that barely scrolls`, kind, "list=task&above=300", async (t) => {
        await t.click(button);
        await t.until("flying", (now) => now.fx === "flying");
        const edges = await t.edges(900);
        const end = await settled(t);
        t.expect("no jump when the flight ends", Math.abs(end[0] - edges.at(-1)![0]) <= 5 && Math.abs(end[1] - edges.at(-1)![1]) <= 5, [edges.at(-1), end]);
        const steps = edges.slice(1).map(([, bottom], index) => Math.abs(bottom - edges[index]![1]));
        t.expect("and no sudden move on the way", Math.max(...steps) <= 60, Math.round(Math.max(...steps)));
      });
    }
    await story("Reduce Motion", kind, "", async (t) => {
      await t.send();
      await sleep(300);
      t.expect("no blob", (await t.look()).fx === "", (await t.look()).fx);
      await t.sent();
      t.expect("no send-off", (await t.trace()) === "", await t.trace());
    }, { reducedMotion: "reduce" });
    await story("the animation code fails to load", kind, "lazy", async (t) => {
      await t.page.route("**/external-draft-send-flight*", (route) => route.abort());
      await t.send();
      await t.sent();
    });
    // The settled Discarded receipt, with nothing of the animation left behind.
    const discarded = async (t: Story) => {
      await t.until("settled as Discarded", (now) => now.status === "Discarded" && now.summary.startsWith("To ") && !now.layer && now.fx !== "flying" && now.fx !== "charging");
      await sleep(250);
      const after = await t.look();
      t.expect("no buttons left on the receipt", !t.button(after, "Send") && !t.button(after, "Discard"), after.buttons);
      t.expect("no animation still running", after.animations === 0, after.animations);
      return after;
    };
    let binned: Look | undefined;
    await story("another device discards it (no animation here)", kind, "", async (t) => {
      await t.remote("dismissed");
      binned = await discarded(t);
      t.expect("no animation played", (await t.trace()) === "", await t.trace());
    });
    await story("plain Discard", kind, "cancel=1500", async (t) => {
      await t.click("Discard");
      await sleep(200);
      const waiting = await t.look();
      t.expect("card is waiting", waiting.fx === "charging", waiting.fx);
      for (const button of waiting.buttons.filter((item) => !item.text.startsWith("Show")))
        t.expect(`"${button.text}" can't be clicked while discarding`, !button.clickable, button);
      if (kind === "email") t.expect("badge doesn't claim it is sending", waiting.status === "Ready to send", waiting.status);
      const seen = await discarded(t);
      t.expect("one request", seen.requests === 1, seen.requests);
      t.expect("animation played once", (await t.trace()) === "charging>flying>landed", await t.trace());
      if (binned) t.expect("same height as the card from history", seen.height === binned.height, [seen.height, binned.height]);
    });
    await story("double-click Discard", kind, "cancel=0", async (t) => {
      await t.twice("Discard");
      const seen = await discarded(t);
      t.expect("one request", seen.requests === 1, seen.requests);
      t.expect("the blob was held for its minimum", (await t.held()) >= 190, await t.held());
    });
    await story("Discard fails, then works", kind, "fail", async (t) => {
      await t.click("Discard");
      const seen = await t.pending();
      t.expect("an error is shown", seen.alert.length > 0, seen.alert);
      await t.set({ fail: false });
      await t.click("Discard");
      await discarded(t);
    });
    await story("leave while discarding, back before the answer", kind, "cancel=2500", async (t) => {
      await t.click("Discard");
      await sleep(400);
      await t.leave();
      await sleep(600);
      await t.back();
      await sleep(120);
      const seen = await t.look();
      t.expect("the grey blob is back", seen.fx === "charging", seen.fx);
      for (const button of seen.buttons.filter((item) => !item.text.startsWith("Show")))
        t.expect(`"${button.text}" can't be clicked on return`, !button.clickable, button);
      const after = await discarded(t);
      t.expect("one request", after.requests === 1, after.requests);
      t.expect("animation played after returning", (await t.trace()).endsWith("charging>flying>landed"), await t.trace());
    });
    await story("leave while discarding, back after the answer", kind, "", async (t) => {
      await t.click("Discard");
      await sleep(100);
      await t.leave();
      await sleep(900);
      await t.back();
      await sleep(60);
      const seen = await t.look();
      t.expect("already the receipt on return", seen.status === "Discarded" && seen.fx !== "charging" && seen.fx !== "flying", seen);
      await discarded(t);
      t.expect("no animation replayed", !(await t.trace()).includes("flying"), await t.trace());
    });
    await story("leave during the Discard animation itself", kind, "", async (t) => {
      await t.click("Discard");
      await t.until("flying", (now) => now.fx === "flying");
      await sleep(250);
      await t.leave();
      await sleep(300);
      await t.back();
      await discarded(t);
    });
    await story("Discard under Reduce Motion", kind, "", async (t) => {
      await t.click("Discard");
      await discarded(t);
      t.expect("no animation", (await t.trace()) === "", await t.trace());
    }, { reducedMotion: "reduce" });
    await story("Discard, then the animation code fails to load", kind, "lazy", async (t) => {
      await t.page.route("**/external-draft-send-flight*", (route) => route.abort());
      await t.click("Discard");
      await discarded(t);
    });
    if (kind === "imessage")
      await story("Escape discards", kind, "", async (t) => {
        await t.escape();
        const seen = await discarded(t);
        t.expect("one request", seen.requests === 1, seen.requests);
      });
    await story("Escape / Discard while waiting does nothing", kind, "latency=1500", async (t) => {
      await t.send();
      await sleep(300);
      await t.escape();
      await t.click("Discard");
      const seen = await t.sent();
      t.expect("one request", seen.requests === 1, seen.requests);
    });
  }
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} stories hold`);
process.exit(failed.length ? 1 : 0);
