const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.SEARCH_TEST_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1040,
    height: 760,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });
  const run = (fn) => win.webContents.executeJavaScript("(" + fn.toString() + ")()");
  const reports = [];
  try {
    await win.loadURL(process.env.SEARCH_TEST_URL + "?search-stress=1");
    reports.push(
      await run(async () => {
        let assertions = 0;
        const check = (value, message) => {
          assertions++;
          if (!value) throw new Error(message);
        };
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const until = async (fn, message) => {
          const deadline = performance.now() + 5000;
          while (!fn() && performance.now() < deadline) await pause(15);
          check(fn(), message);
        };
        const input = () => document.querySelector('input[aria-label="Search"]');
        const dialog = () => document.querySelector('[role="dialog"]');
        const rows = () => [...document.querySelectorAll("[data-search-result-index]")];
        const state = () => JSON.parse(document.querySelector("#fixture-state").textContent);
        const selected = () => document.querySelector('[role="option"][aria-selected="true"]');
        const button = () => document.querySelector('button[aria-label="Search"]');
        const key = (value, extra = {}) =>
          input().dispatchEvent(
            new KeyboardEvent("keydown", { key: value, bubbles: true, ...extra })
          );
        const fill = (value) => {
          const el = input();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        const open = async () => {
          button().click();
          await until(input, "Search opens");
        };
        const close = async () => {
          key("Escape");
          await until(() => !dialog(), "Search closes");
        };
        const query = async (value, match) => {
          fill(value);
          await until(
            () => rows().some((r) => r.textContent.includes(match)),
            `Results arrive for ${value}`
          );
        };
        await until(button, "Fixture mounts");
        await open();
        await until(() => rows().length === 4, "Default search loads bots and chats");
        check(document.activeElement === input(), "Search takes focus immediately");
        await query("general", "General");
        check(
          [...dialog().querySelectorAll("[data-search-highlight]")]
            .map((e) => e.textContent)
            .join() === "General",
          "Settings breadcrumbs highlight the matched destination"
        );
        check(
          getComputedStyle(dialog().querySelector(".desktop-search-settings-prefix")).fontWeight ===
            "425",
          "Unmatched Settings prefix keeps regular weight"
        );
        await query("settings", "General");
        check(
          [...dialog().querySelectorAll("[data-search-highlight]")].every(
            (e) => e.textContent === "Settings"
          ),
          "Settings prefix highlights only when matched"
        );
        await query("theme", "Dark");
        check(
          Boolean(dialog().querySelector('[aria-label="Current"]')),
          "Current setting shows its checkmark"
        );
        key("Meta", { metaKey: true });
        await until(
          () => dialog().querySelector("kbd"),
          "Modifier shortcut replaces the current checkmark"
        );
        check(
          !dialog().querySelector('[aria-label="Current"]'),
          "Modifier hint takes precedence over current checkmark"
        );
        input().dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
        await query("bulk", "Bulk 000");
        check(rows().length === 120, "All server results render");
        check(
          [...document.querySelectorAll("[data-search-section]")]
            .map((e) => e.textContent)
            .join() === "Bots,Chats,Messages,Files,Links,Routines",
          "Every result kind has one ordered group"
        );
        for (let i = 0; i < 125; i++) {
          key("ArrowDown");
          await until(
            () => selected()?.dataset.searchResultIndex === String(Math.min(i + 1, 119)),
            "Down traverses all groups and clamps at the last result"
          );
          const box = selected().getBoundingClientRect(),
            viewport = document.querySelector("#search-results").getBoundingClientRect();
          check(
            box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1,
            "Keyboard-selected result stays in the viewport"
          );
          check(
            input().getAttribute("aria-activedescendant") === selected().id,
            "Combobox points to selected option"
          );
        }
        for (let i = 0; i < 125; i++) {
          key("ArrowUp");
          await pause(1);
        }
        check(selected()?.dataset.searchResultIndex === "0", "Up clamps at the first result");
        key("Meta", { metaKey: true });
        await until(
          () => dialog().querySelectorAll("kbd").length === 9,
          "Command reveals nine shortcuts"
        );
        input().dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
        await until(
          () => dialog().querySelectorAll("kbd").length === 0,
          "Releasing Command hides shortcuts"
        );
        key("Enter", { isComposing: true });
        await pause(30);
        check(Boolean(dialog()), "IME Enter never navigates");
        key("9", { metaKey: true });
        await until(() => !dialog(), "Command+9 navigates");
        check(state().selected === "target-bot-48", "Shortcut index follows visual grouping");
        await open();
        await until(() => rows().length === 4, "Reopen resets default results");
        await query("bulk", "Bulk 000");
        rows()[21].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await until(
          () => selected()?.dataset.searchResultIndex === "21",
          "Pointer changes selection"
        );
        rows()[21].click();
        await until(() => !dialog(), "Click selects a result");
        check(state().selected === "target-channel-7", "Click follows grouped row identity");
        await open();
        fill("slow-old");
        await until(
          () => window.panelSearchLog.some((e) => e.query === "slow-old"),
          "Slow request starts"
        );
        fill("fast-new");
        await until(
          () => rows().some((r) => r.textContent.includes("Fast new reply")),
          "New request wins"
        );
        await pause(330);
        check(
          rows().length === 1 && rows()[0].textContent.includes("Fast new reply"),
          "Late obsolete replies cannot overwrite current results"
        );
        check(
          window.panelSearchLog.find((e) => e.query === "slow-old").aborted,
          "Old query transport is aborted"
        );
        fill("empty-probe");
        await pause(5);
        key("Enter");
        await pause(20);
        check(Boolean(dialog()), "Changing a query makes old results immediately unselectable");
        await until(
          () => dialog()?.textContent.includes("No results"),
          "Empty results are explicit"
        );
        key("ArrowDown");
        key("ArrowUp");
        key("Enter");
        key("1", { ctrlKey: true });
        await pause(20);
        check(
          Boolean(dialog()) && !input().getAttribute("aria-activedescendant"),
          "Empty-list navigation is inert and accessible"
        );
        fill("error-probe");
        await until(
          () => dialog()?.textContent.includes("Search is unavailable"),
          "Request errors show an error state"
        );
        await query("日本語", "日本語アシスタント");
        check(
          !dialog().textContent.includes("Search is unavailable"),
          "A later query recovers from errors"
        );
        await query("long", "Long");
        check(
          document.documentElement.scrollWidth === innerWidth &&
            dialog().scrollWidth === dialog().clientWidth,
          "Long titles and descriptions cannot widen the panel"
        );
        const hostile = '<img src=x onerror="window.searchEscaped=true">';
        await query(hostile, "<img");
        check(
          !dialog().querySelector("img") && window.searchEscaped !== true,
          "Result text is rendered as text, never HTML"
        );
        await query("body-match", "Server matched the message body");
        check(rows().length === 1, "Server-side body matches are not discarded by title ranking");
        fill("close-pending");
        await until(
          () => window.panelSearchLog.some((e) => e.query === "close-pending"),
          "Pending close request starts"
        );
        await close();
        await pause(330);
        await open();
        await until(() => rows().length === 4, "Late closed replies do not leak into reopen");
        check(
          input().value === "" && !dialog().textContent.includes("Closed request reply"),
          "Every open starts with an empty query"
        );
        const callsBefore = window.panelSearchLog.filter((e) => e.query === "bulk").length;
        await query("bulk", "Bulk 000");
        await pause(100);
        check(
          window.panelSearchLog.filter((e) => e.query === "bulk").length === callsBefore,
          "Fresh repeated queries use cached results"
        );
        await close();
        const draft = document.querySelector('[aria-label="Message draft"]');
        for (let i = 0; i < 30; i++) {
          draft.focus();
          const range = document.createRange();
          range.setStart(draft.firstChild, 4);
          range.collapse(true);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          await open();
          await until(() => rows().length === 4, "Repeated opens reset results");
          check(input().value === "", "Repeated opens reset query");
          await close();
          check(
            document.activeElement === draft && getSelection().anchorOffset === 4,
            "Dismissal restores draft focus and caret"
          );
        }
        return {
          scenario: "search stress",
          assertions,
          resultKinds: 6,
          resultRows: 120,
          keyboardSteps: 250,
          reopenCycles: 30,
        };
      })
    );
    await win.loadURL(process.env.SEARCH_TEST_URL + "?search-stress=1&offline=1");
    reports.push(
      await run(async () => {
        const pause = () => new Promise((r) => setTimeout(r, 30));
        for (let i = 0; i < 150 && !document.querySelector('button[aria-label="Search"]'); i++)
          await pause();
        document.querySelector('button[aria-label="Search"]').click();
        for (let i = 0; i < 150 && !document.querySelector('input[aria-label="Search"]'); i++)
          await pause();
        const input = document.querySelector('input[aria-label="Search"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
          input,
          "settings"
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
        for (let i = 0; i < 150 && !document.querySelector('[data-search-section="Settings"]'); i++)
          await pause();
        await new Promise((r) => setTimeout(r, 150));
        if (document.querySelectorAll('[role="option"]').length !== 3)
          throw Error("Offline search keeps local settings actions");
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true })
        );
        await pause();
        if (!JSON.parse(document.querySelector("#fixture-state").textContent).action)
          throw Error("Offline settings action executes");
        return { scenario: "offline settings", assertions: 2 };
      })
    );
    await win.loadURL(process.env.SEARCH_TEST_URL + "?search-stress=1");
    for (const size of [
      [1040, 760],
      [900, 600],
      [680, 500],
      [360, 420],
      [320, 320],
      [1280, 900],
    ]) {
      win.setContentSize(...size);
      for (const theme of ["light", "dark"]) {
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.theme=${JSON.stringify(theme)}`
        );
        const layout = await run(async () => {
          const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
          for (let i = 0; i < 200 && !document.querySelector('button[aria-label="Search"]'); i++)
            await pause();
          document.querySelector('button[aria-label="Search"]').click();
          for (let i = 0; i < 200 && document.querySelectorAll('[role="option"]').length !== 4; i++)
            await pause();
          const d = document.querySelector('[role="dialog"]'),
            field = d.querySelector("input");
          const r = d.getBoundingClientRect(),
            f = field.getBoundingClientRect();
          const check = (ok, message) => {
            if (!ok)
              throw Error(
                message +
                  ` (${innerWidth}×${innerHeight}, ${document.documentElement.dataset.theme})`
              );
          };
          check(
            r.width === Math.min(642, innerWidth - 32) &&
              r.height === Math.min(562, innerHeight - 32),
            "Responsive search dimensions"
          );
          check(
            f.left - r.left === 59 && r.right - f.right === 11 && f.top - r.top === 19,
            `Search input insets match reference across sizes: ${JSON.stringify({ dialog: r.toJSON(), input: f.toJSON() })}`
          );
          check(
            getComputedStyle(field).fontSize === "22px" &&
              getComputedStyle(field).lineHeight === "28px",
            "Reference input text scale"
          );
          check(
            [...d.querySelectorAll('[role="option"]')].every((e) => e.tabIndex === -1),
            "Results stay out of Tab order"
          );
          const row = d.querySelector('[role="option"]').getBoundingClientRect();
          check(
            row.left - r.left === 11 &&
              r.right - row.right === 11 &&
              row.top - r.top === 99 &&
              row.height === 56,
            "Reference result padding and height"
          );
          check(
            d.scrollWidth === d.clientWidth && document.documentElement.scrollWidth === innerWidth,
            "No horizontal overflow"
          );
          const dark = document.documentElement.dataset.theme === "dark";
          check(
            getComputedStyle(d).backgroundColor ===
              (dark ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)"),
            "Reference surface color"
          );
          check(
            getComputedStyle(d.querySelector('[role="option"]')).backgroundColor ===
              (dark ? "rgba(245, 245, 245, 0.08)" : "rgba(28, 28, 28, 0.08)"),
            "Reference selection fill"
          );
          return {
            width: innerWidth,
            height: innerHeight,
            theme: document.documentElement.dataset.theme,
            assertions: 8,
          };
        });
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
        await run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (document.activeElement?.getAttribute("aria-label") !== "Search")
            throw Error("Native Tab keeps focus in search");
        });
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (document.querySelector('[role="dialog"]'))
            throw Error("Native Escape dismisses search");
        });
        reports.push({ ...layout, assertions: 10 });
      }
    }
    fs.writeFileSync(
      path.join(process.env.SEARCH_TEST_DIR, "results.json"),
      JSON.stringify({ passed: true, reports })
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(process.env.SEARCH_TEST_DIR, "results.json"),
      JSON.stringify({ error: error.message, stack: error.stack, reports })
    );
  } finally {
    app.quit();
  }
});
