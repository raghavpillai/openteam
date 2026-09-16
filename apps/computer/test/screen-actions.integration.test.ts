import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, type Page } from "playwright-core";
import { performComputerUseAction } from "../src/screen/actions";
import { run } from "../src/screen/processes";

// Run in the computer image. A private X server keeps this suite off bot desktops.
describe.skipIf(process.platform !== "linux" || !Bun.which("Xvfb"))(
  "real X11 computer input",
  () => {
    let xvfb: ChildProcess;
    let browser: Browser;
    let page: Page;
    let env: NodeJS.ProcessEnv;

    beforeAll(async () => {
      xvfb = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const display = await new Promise<string>((resolve, reject) => {
        xvfb.once("error", reject);
        xvfb.once("exit", (code) => reject(new Error(`Xvfb exited ${code}`)));
        xvfb.stdout!.once("data", (data) => resolve(String(data).trim()));
      });
      env = { ...process.env, DISPLAY: `:${display}`, LANG: "C", LC_ALL: "C", LC_CTYPE: "C" };
      browser = await chromium.launch({
        executablePath: "/usr/local/bin/google-chrome",
        headless: false,
        env: env as Record<string, string>,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
      });
      page = await browser.newPage({ viewport: { width: 1100, height: 650 } });
      await page.setContent("<title>CUA input regression</title><input>");
      await page.bringToFront();
      const focus = Bun.spawn(
        ["xdotool", "search", "--sync", "--onlyvisible", "--class", "chromium", "windowfocus"],
        {
          env,
          stdout: "ignore",
          stderr: "pipe",
        }
      );
      if (await focus.exited) throw new Error(await new Response(focus.stderr).text());
    }, 20_000);

    afterAll(async () => {
      await browser?.close();
      xvfb?.kill();
    });

    test("repeated pointer coordinates return promptly", async () => {
      const start = performance.now();
      for (let i = 0; i < 3; i++) {
        await performComputerUseAction({ action: "move", x: 20, y: 20 }, env);
      }
      const elapsedMs = performance.now() - start;
      console.info(`Repeated moves: ${Math.round(elapsedMs)} ms`);
      expect(elapsedMs).toBeLessThan(3_000);
    }, 5_000);

    test("repeated clicks deliver all 40 trusted inputs without coordinate stalls", async () => {
      await page.setContent(`<button style="position:fixed;inset:0" id="pulse">0</button>
        <script>let count=0; pulse.onclick=e=>{if(e.isTrusted)pulse.textContent=++count}</script>`);
      const start = performance.now();
      for (let i = 0; i < 14; i++) {
        await performComputerUseAction(
          { action: "click", x: 400, y: 400, count: i < 13 ? 3 : 1 },
          env
        );
      }
      await page.waitForFunction(() => document.querySelector("#pulse")?.textContent === "40");
      const elapsedMs = performance.now() - start;
      console.info(`40 repeated clicks: ${Math.round(elapsedMs)} ms`);
      expect(elapsedMs).toBeLessThan(12_000);
    }, 15_000);

    test("key modifiers select text and leave subsequent keys unmodified", async () => {
      await page.setContent('<input id="field" value="old text">');
      await page.locator("#field").focus();
      await performComputerUseAction({ action: "key", key: "a", modifiers: "ctrl" }, env);
      await performComputerUseAction({ action: "type", text: "abc def" }, env);
      expect(await page.locator("#field").inputValue()).toBe("abc def");
      await performComputerUseAction({ action: "key", key: "Left", modifiers: "ctrl+shift" }, env);
      await performComputerUseAction({ action: "type", text: "x" }, env);
      await performComputerUseAction({ action: "key", key: "a" }, env);
      await page.waitForFunction(
        () => (document.querySelector("#field") as HTMLInputElement).value === "abc xa"
      );
      await performComputerUseAction({ action: "key", key: "ctrl+a" }, env);
      await performComputerUseAction({ action: "type", text: "inline chord works" }, env);
      expect(await page.locator("#field").inputValue()).toBe("inline chord works");
    });

    test("normalizes common key aliases and rejects unknown key names", async () => {
      await page.setContent(`<textarea id="field"></textarea><script>
        window.keys=[];document.addEventListener('keydown',e=>window.keys.push(e.key));
      </script>`);
      await page.locator("#field").focus();
      for (const key of ["ENTER", "ESC", "ArrowLeft", "BACKSPACE"]) {
        await performComputerUseAction({ action: "key", key }, env);
      }
      expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([
        "Enter",
        "Escape",
        "ArrowLeft",
        "Backspace",
      ]);
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(
          performComputerUseAction({ action: "key", key: "DefinitelyNotAKey" }, env)
        ).rejects.toThrow();
      }
    });

    test("held clicks last for the requested duration and cancellation releases the button", async()=>{
      await page.setContent(`<div style="position:fixed;inset:0"></div><script>window.events=[];for(const type of ['pointerdown','pointerup'])document.addEventListener(type,e=>events.push({type,t:performance.now(),buttons:e.buttons,trusted:e.isTrusted}));</script>`);
      await performComputerUseAction({action:"click",x:300,y:300,holdDurationMs:180},env);
      await page.waitForFunction(()=>(window as any).events.length===2);
      let events=await page.evaluate(()=>(window as any).events);
      expect(events[1].t-events[0].t).toBeGreaterThanOrEqual(150);expect(events[1].buttons).toBe(0);expect(events[1].trusted).toBe(true);
      const abort=new AbortController();setTimeout(()=>abort.abort(),150);
      await expect(performComputerUseAction({action:"click",x:300,y:300,holdDurationMs:2000},env,abort.signal)).rejects.toThrow();
      await page.waitForFunction(()=>(window as any).events.length===4);
      events=await page.evaluate(()=>(window as any).events);expect(events.at(-1).buttons).toBe(0);
    });

    test("types exact multilingual text, emoji and newline with an inherited C locale", async () => {
      await page.setContent('<textarea id="field"></textarea>');
      await page.locator("#field").focus();
      const text = "café Ω 東京 🙂\nline two";
      await performComputerUseAction({ action: "type", text }, env);
      await page.waitForFunction(
        (expected) => (document.querySelector("#field") as HTMLTextAreaElement).value === expected,
        text
      );
      expect(env.LC_ALL).toBe("C");
    });

    test("types more unique Unicode characters than spare keycodes and restores the keymap", async () => {
      await page.setContent('<textarea id="field"></textarea>');
      await page.locator("#field").focus();
      const mapping = () => run("xmodmap", ["-pke"], { env, captureStdout: true });
      const before = (await mapping()).toString();
      const text = "Éé Åå Çç Øø ß ẞ Ελληνικά русский العربية 中文 日本語 한글 🙂👩🏽‍💻";
      await performComputerUseAction({ action: "type", text }, env);
      expect(await page.locator("#field").inputValue()).toBe(text);
      expect((await mapping()).toString()).toBe(before);
    });

    test("drag paths tolerate repeated waypoints and release the button", async () => {
      await page.setContent(`<div style="position:fixed;inset:0"></div>
        <script>window.dragEvents=[]; for(const type of ['pointerdown','pointermove','pointerup'])
          document.addEventListener(type,e=>window.dragEvents.push({type,buttons:e.buttons,trusted:e.isTrusted}));</script>`);
      const start = performance.now();
      await performComputerUseAction(
        {
          action: "drag",
          path: [
            { x: 200, y: 300 },
            { x: 200, y: 300 },
            { x: 450, y: 400 },
            { x: 450, y: 400 },
          ],
        },
        env
      );
      await page.waitForFunction(() =>
        (window as unknown as { dragEvents: { type: string }[] }).dragEvents.some(
          (event) => event.type === "pointerup"
        )
      );
      const events = await page.evaluate(
        () =>
          (
            window as unknown as {
              dragEvents: { type: string; buttons: number; trusted: boolean }[];
            }
          ).dragEvents
      );
      expect(
        events.some((event) => event.type === "pointerdown" && event.buttons === 1 && event.trusted)
      ).toBe(true);
      expect(
        events.some((event) => event.type === "pointermove" && event.buttons === 1 && event.trusted)
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "pointerup", buttons: 0, trusted: true });
      expect(performance.now() - start).toBeLessThan(3_000);
    }, 5_000);
  }
);
