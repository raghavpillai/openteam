const { app, BrowserWindow } = require("electron");
const fs = require("fs"),
  path = require("path");
app.setPath("userData", path.join(process.env.DESKTOP_STYLE_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1456,
    height: 924,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });
  win.focus();
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  const reports = [];
  try {
    for (const theme of ["dark", "light"]) {
      await win.loadURL(process.env.DESKTOP_STYLE_URL + "?theme=" + theme + "&onboarding");
      reports.push(
        await run(async () => {
          localStorage.removeItem("openteam:library-pins:review-chat");
          const check = (v, m) => {
            if (!v) throw Error(m);
          };
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          const wait = async (fn) => {
            for (let i = 0; i < 150; i++) {
              if (fn()) return;
              await pause(30);
            }
            throw Error(
              "Timed out waiting for full App: " +
                JSON.stringify({
                  name: document.querySelector('input[aria-label="Bot name"]')?.value,
                  title: document.querySelector("[data-chat-header-title]")?.textContent,
                  alert: document.querySelector('[role="alert"]')?.textContent,
                  panel: document.querySelector('[role="tabpanel"]')?.textContent,
                  dialog: document.querySelector('[role="dialog"]')?.textContent,
                })
            );
          };
          const button = (label) => document.querySelector(`button[aria-label="${label}"]`);
          await wait(
            () =>
              document.querySelector(".message-bubble") && document.querySelector(".widget-options")
          );
          await pause(350);
          check(!button("OpenTeam's Computer"), "Obsolete top-right computer button remains");
          button("View conversation details").click();
          await pause(350);
          const pill = button("View conversation details"),
            rect = pill.getBoundingClientRect();
          check(rect.y === 10 && rect.height === 41, "Header geometry differs from reference");
          check(
            document.querySelector('section[aria-label="Suggested"]').getBoundingClientRect().y ===
              240,
            "Profile-to-section gap differs from reference"
          );
          const bubble = document.querySelector(".message-bubble"),
            s = getComputedStyle(bubble);
          check(
            s.fontSize === "15px" && s.fontWeight === "425" && s.padding === "7px 12px",
            "Bubble type or padding mismatch"
          );
          check(
            getComputedStyle(document.querySelector("[contenteditable]")).fontSize === "14px",
            "Composer type mismatch"
          );
          const options = getComputedStyle(document.querySelector(".widget-options"));
          check(
            options.backgroundColor === "rgba(0, 0, 0, 0)" &&
              options.borderWidth === "0px" &&
              options.borderRadius === "0px",
            "Lazy widget CSS overrides conversation styling"
          );
          const user = getComputedStyle(
            document.querySelector('.message-bubble[data-role="user"]')
          );
          check(
            user.backgroundColor ===
              (document.documentElement.dataset.theme === "dark"
                ? "rgba(245, 245, 245, 0.18)"
                : "rgb(28, 28, 28)"),
            "User bubble theme color mismatch"
          );
          const name = document.querySelector('input[aria-label="Bot name"]');
          const blurName = () => {
            let delivered = false;
            const onBlur = () => {
              delivered = true;
            };
            name.addEventListener("focusout", onBlur);
            name.blur();
            name.removeEventListener("focusout", onBlur);
            if (!delivered) name.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          };
          check(name, "Profile name is not editable");
          const fill = (value) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
              name,
              value
            );
            name.dispatchEvent(new Event("input", { bubbles: true }));
          };
          name.focus();
          fill("Renamed bot");
          await pause(50);
          blurName();
          await pause(200);
          await wait(() => button("View conversation details").textContent.includes("Renamed bot"));
          check(name.value === "Renamed bot", "Inline name did not persist");
          name.focus();
          fill("Cancelled name");
          await pause(50);
          let escapedBlur = false;
          const onEscapeBlur = () => {
            escapedBlur = true;
          };
          name.addEventListener("focusout", onEscapeBlur);
          name.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          name.removeEventListener("focusout", onEscapeBlur);
          // Escape already blurs the input when the native window owns focus.
          // Only synthesize the missing event for an inactive test window.
          if (!escapedBlur) blurName();
          await pause(100);
          check(name.value === "Renamed bot", "Escape saved the cancelled name");
          name.focus();
          fill("Fail rename");
          await pause(50);
          blurName();
          await pause(150);
          check(
            document.querySelector('[role="alert"]')?.textContent.includes("Could not save name"),
            "Rename failure is not recoverable"
          );
          name.focus();
          fill("Cap c18-1");
          await pause(50);
          blurName();
          await pause(200);
          check(!document.querySelector('[role="alert"]'), "Rename retry did not clear failure");
          check(
            document.querySelector(".bot-computer-placeholder"),
            "Computer placeholder artwork missing"
          );
          const tab = (label) =>
            [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent === label);
          tab("Library").click();
          await wait(() => button("sales_summary.xlsx"));
          check(
            document.querySelector(".bot-library-row").getBoundingClientRect().height === 36,
            "Library row height differs"
          );
          button("sales_summary.xlsx").click();
          await wait(() => document.querySelector('[role="dialog"] table'));
          check(
            document.querySelector('[role="dialog"]').textContent.includes("January"),
            "Library spreadsheet preview missing"
          );
          button("Close preview").click();
          await pause(180);
          [...document.querySelectorAll("button")]
            .find((el) => el.textContent === "Load more")
            .click();
          await wait(() => button("older-notes.txt"));
          button("More actions for older-notes.txt").dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })
          );
          await wait(() => document.querySelector('[role="menuitem"]'));
          [...document.querySelectorAll('[role="menuitem"]')]
            .find((el) => el.textContent === "Pin")
            .click();
          await pause(180);
          tab("Activity").click();
          tab("Library").click();
          await wait(() => document.querySelector('ul[aria-label="Pinned"]'));
          check(button("older-notes.txt"), "Older pinned file disappeared after reopening Library");
          tab("Library").dispatchEvent(
            new KeyboardEvent("keydown", { key: "Home", bubbles: true })
          );
          await pause(100);
          check(
            tab("Activity").getAttribute("aria-selected") === "true",
            "Library keyboard navigation failed"
          );
          const card = button("Open computer");
          check(
            card && card.querySelector(".bot-computer-status"),
            "Whole computer row is not the trigger"
          );
          card.click();
          await wait(() => button("Close computer view"));
          button("Close computer view").click();
          await pause(100);
          button("Edit Bot profile").click();
          await wait(() => document.querySelector('textarea[aria-label="Bot description"]'));
          check(
            !document.querySelector(
              'input[aria-label="Bot label"], textarea[aria-label="Bot instructions"]'
            ),
            "Retired profile controls remain"
          );
          button("Back to details").click();
          await wait(() => document.querySelector(".bot-details-profile"));
          const panel = document.querySelector('section[aria-label="Conversation details"]');
          button("Close details").click();
          await pause(90);
          check(
            panel.getBoundingClientRect().width > 0 && getComputedStyle(panel).opacity === "1",
            "Closing hides panel before width collapse"
          );
          check(
            getComputedStyle(panel.firstElementChild).opacity === "1",
            "Closing hides panel contents"
          );
          await pause(300);
          check(document.activeElement === pill, "Close did not restore title focus");
          return {
            theme: document.documentElement.dataset.theme,
            checks: [
              "type and geometry",
              "theme colors",
              "lazy widget CSS",
              "inline rename/save/cancel/retry",
              "whole computer card and placeholder artwork",
              "Library paging, spreadsheet preview, durable pin and keyboard tabs",
              "visible panel collapse",
              "title focus",
              "removed top-right icon",
            ],
          };
        })
      );
    }
    for (const theme of ["light", "dark"]) {
      const colorURL = process.env.DESKTOP_STYLE_URL + "?theme=" + theme + "&botColor=%23ff9e12";
      await win.loadURL(colorURL);
      reports.push(
        await run(async () => {
          const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const wait = async (predicate) => {
            for (let i = 0; i < 150; i++) {
              if (predicate()) return;
              await pause(30);
            }
            throw Error("Message colors setting did not update");
          };
          const bubble = () => document.querySelector('.message-bubble[data-role="user"]');
          await wait(bubble);
          window.dispatchEvent(
            new CustomEvent("openteam:deep-link", {
              detail: { url: "openteam://app/v1/settings?id=theme" },
            })
          );
          const toggle = () =>
            document.querySelector(
              'button[role="switch"][aria-label="Use bot colors for messages"]'
            );
          await wait(toggle);
          if (toggle().getAttribute("aria-checked") !== "false")
            throw Error("Bot colors should default off");
          toggle().click();
          await wait(
            () =>
              getComputedStyle(bubble()).backgroundColor ===
              (document.documentElement.dataset.theme === "dark"
                ? "rgb(200, 119, 12)"
                : "rgb(194, 115, 11)")
          );
          if (
            getComputedStyle(bubble()).color !==
            (document.documentElement.dataset.theme === "dark"
              ? "rgb(245, 245, 245)"
              : "rgb(255, 255, 255)")
          )
            throw Error("Bot bubbles must use the reference light text");
          if (localStorage.getItem("openteam:bot-message-colors") !== "true")
            throw Error("Bot color preference was not saved");
          document.querySelector('[role="dialog"] button[aria-label="Close"]').click();
          return {
            theme: document.documentElement.dataset.theme,
            checks: [
              "Appearance toggle defaults off",
              "reference bot palette and light text",
              "preference saved",
            ],
          };
        })
      );
      await win.loadURL(colorURL);
      reports.push(
        await run(async () => {
          const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const wait = async (predicate) => {
            for (let i = 0; i < 150; i++) {
              if (predicate()) return;
              await pause(30);
            }
            throw Error("Message colors did not restore after reload");
          };
          const bubble = () => document.querySelector('.message-bubble[data-role="user"]');
          await wait(
            () =>
              bubble() &&
              getComputedStyle(bubble()).backgroundColor ===
                (document.documentElement.dataset.theme === "dark"
                  ? "rgb(200, 119, 12)"
                  : "rgb(194, 115, 11)")
          );
          window.dispatchEvent(
            new CustomEvent("openteam:deep-link", {
              detail: { url: "openteam://app/v1/settings?id=theme" },
            })
          );
          const toggle = () =>
            document.querySelector(
              'button[role="switch"][aria-label="Use bot colors for messages"]'
            );
          await wait(toggle);
          if (toggle().getAttribute("aria-checked") !== "true")
            throw Error("Saved toggle state was not restored");
          toggle().click();
          const neutral =
            document.documentElement.dataset.theme === "dark"
              ? "rgba(245, 245, 245, 0.18)"
              : "rgb(28, 28, 28)";
          await wait(() => getComputedStyle(bubble()).backgroundColor === neutral);
          document.querySelector('[role="dialog"] button[aria-label="Close"]').click();
          return {
            checks: ["preference survives reload", "disabling immediately restores theme gray"],
          };
        })
      );
    }
    await win.loadURL(process.env.DESKTOP_STYLE_URL + "?group");
    reports.push(
      await run(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 150 && !document.querySelector("[data-chat-header-title] button"); i++)
          await pause(30);
        document.querySelector("[data-chat-header-title] button").click();
        await pause(400);
        const gear = document.querySelector('button[aria-label="Conversation settings"]');
        if (!gear) throw Error("Group settings entry missing");
        gear.click();
        await pause(350);
        if (!document.querySelector('aside[aria-label="Settings"] input'))
          throw Error("Group settings did not open");
        if (document.activeElement?.getAttribute("aria-label") !== "Back to details")
          throw Error("Group settings did not focus its back button");
        return { checks: ["direct group settings access", "settings focus"] };
      })
    );
    await win.loadURL(process.env.DESKTOP_STYLE_URL + "?history=1000");
    reports.push(
      await run(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 150 && !document.querySelector(".message-bubble"); i++) await pause(30);
        const pill = document.querySelector('button[aria-label="View conversation details"]');
        pill.click();
        await pause(600);
        const intervals = [],
          longTasks = [];
        let last = performance.now(),
          active = true;
        const observer = new PerformanceObserver((list) =>
          longTasks.push(...list.getEntries().map((e) => e.duration))
        );
        observer.observe({ type: "longtask" });
        const frame = (now) => {
          if (!active) return;
          intervals.push(now - last);
          last = now;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        for (let i = 0; i < 6; i++) {
          document.querySelector('button[aria-label="Close details"]').click();
          await pause(380);
          pill.click();
          await pause(380);
        }
        active = false;
        observer.disconnect();
        intervals.shift();
        intervals.sort((a, b) => a - b);
        const p95 = intervals[Math.floor(intervals.length * 0.95)],
          rows = document.querySelectorAll("[data-message-id]").length;
        if (p95 > 34) throw Error("Panel animation p95 exceeds 34ms: " + p95);
        if (rows > 60) throw Error("Panel motion defeats transcript virtualization: " + rows);
        return {
          checks: ["panel frame pacing with 1000 messages", "bounded rendering"],
          frames: intervals.length,
          p95FrameMs: p95,
          maxFrameMs: Math.max(...intervals),
          longTasks,
          renderedRows: rows,
        };
      })
    );
    win.webContents.debugger.attach("1.3");
    // Exercise the header over the same 1000-message conversation. Hover must
    // keep layout stable, including rapid reversals on a slower CPU.
    const cdp = win.webContents.debugger;
    const headerPoint = await run(async () => {
      document.querySelector('button[aria-label="Close details"]').click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      document.activeElement?.blur();
      const rect = document.querySelector(".desktop-conversation-pill").getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    const hoverHeader = (hover) => cdp.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: hover ? headerPoint.x : 5,
      y: hover ? headerPoint.y : 100,
    });
    await hoverHeader(false);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await cdp.sendCommand("Emulation.setCPUThrottlingRate", { rate: 4 });
    try {
      await run(() => {
        const pill = document.querySelector(".desktop-conversation-pill");
        const sample = window.headerMotionSample = {
          frames: [], longTasks: [], resizes: 0, active: true,
          width: pill.getBoundingClientRect().width,
        };
        sample.resizeObserver = new ResizeObserver(() => sample.resizes++);
        sample.resizeObserver.observe(pill);
        sample.taskObserver = new PerformanceObserver((list) =>
          sample.longTasks.push(...list.getEntries().map((entry) => entry.duration))
        );
        sample.taskObserver.observe({ type: "longtask" });
        let last;
        const frame = (now) => {
          if (!sample.active) return;
          if (last) sample.frames.push(now - last);
          last = now;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      for (let i = 0; i < 12; i++) {
        await hoverHeader(i % 2 === 0);
        await new Promise((resolve) => setTimeout(resolve, i < 4 ? 700 : 140));
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      const report = await run(() => {
        const sample = window.headerMotionSample;
        sample.active = false;
        sample.resizeObserver.disconnect();
        sample.taskObserver.disconnect();
        const frames = sample.frames.sort((a, b) => a - b);
        const pill = document.querySelector(".desktop-conversation-pill");
        if (sample.resizes > 1 || pill.getBoundingClientRect().width !== sample.width)
          throw Error("Header hover changes layout size");
        if (pill.getAnimations({ subtree: true }).some((animation) =>
          animation.playState === "running" && animation.effect?.target?.matches(
            ".desktop-conversation-surface, .desktop-conversation-name, .desktop-conversation-avatar, .desktop-conversation-chevron"
          )
        ))
          throw Error("Header keeps animating after hover settles");
        const p95FrameMs = frames[Math.floor(frames.length * .95)];
        if (p95FrameMs > 34) throw Error("Header animation p95 exceeds 34ms: " + p95FrameMs);
        return {
          checks: ["header hover at 4x CPU slowdown with 1000 messages", "stable layout", "idle animation stops"],
          frames: frames.length, p95FrameMs, maxFrameMs: Math.max(...frames), longTasks: sample.longTasks,
        };
      });
      reports.push(report);
    } finally {
      await cdp.sendCommand("Emulation.setCPUThrottlingRate", { rate: 1 });
    }
    await run(() => document.querySelector(".desktop-conversation-pill").click());
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    reports.push(
      await run(async () => {
        const panel = document.querySelector('section[aria-label="Conversation details"]');
        if (getComputedStyle(panel).transitionDuration !== "0s")
          throw Error("Panel ignores reduced motion");
        const chevron = document.querySelector(".desktop-conversation-chevron");
        if (
          getComputedStyle(chevron)
            .transitionDuration.split(",")
            .some((s) => parseFloat(s) !== 0)
        )
          throw Error("Header hover ignores reduced motion");
        return { checks: ["reduced motion"] };
      })
    );
    fs.writeFileSync(
      path.join(process.env.DESKTOP_STYLE_DIR, "results.json"),
      JSON.stringify({ passed: true, reports })
    );
  } catch (e) {
    fs.writeFileSync(
      path.join(process.env.DESKTOP_STYLE_DIR, "results.json"),
      JSON.stringify({ error: String(e), stack: e.stack, reports })
    );
  }
  app.quit();
});
