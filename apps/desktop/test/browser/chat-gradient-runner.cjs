const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.CHAT_GRADIENT_DIR, "profile"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 760,
      useContentSize: true,
      webPreferences: { backgroundThrottling: false },
    });
    const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);
    const reports = [];
    const headers = [];
    try {
      for (const theme of ["light", "dark"]) {
        nativeTheme.themeSource = theme;
        for (const long of [false, true]) {
          await win.loadURL(
            `${process.env.CHAT_GRADIENT_URL}?theme=${theme}${long ? "&long" : ""}`
          );
          for (let attempt = 0; attempt < 200; attempt++) {
            if (
              await run(
                () => !!document.querySelector('[data-chat-layout-ready="true"] .message-bubble')
              )
            )
              break;
            if (attempt === 199) throw new Error("Transcript failed to load");
            await pause(50);
          }
          await pause(300);
          // Measured in the installed Grok Bot desktop app on 2026-11-12,
          // using its Light/Dark setting, at the top, middle and bottom of chat.
          const header = await run(() => {
            const el = document.querySelector(".desktop-conversation-header");
            const style = getComputedStyle(el);
            return {
              height: el.getBoundingClientRect().height,
              top: el.getBoundingClientRect().top,
              backgroundImage: style.backgroundImage,
              backgroundColor: style.backgroundColor,
              opacity: style.opacity,
              maskImage: style.maskImage,
              filter: style.filter,
              backdropFilter: style.backdropFilter,
              backgroundSize: style.backgroundSize,
              backgroundPosition: style.backgroundPosition,
            };
          });
          const rgb = theme === "light" ? "252, 252, 252" : "18, 18, 18";
          const reference = {
            height: 61,
            top: 0,
            backgroundImage: `linear-gradient(rgb(${rgb}), rgba(0, 0, 0, 0))`,
            backgroundColor: "rgba(0, 0, 0, 0)",
            opacity: "1",
            maskImage: "none",
            filter: "none",
            backdropFilter: "none",
            backgroundSize: "auto",
            backgroundPosition: "0% 0%",
          };
          for (const key of Object.keys(reference)) {
            if (header[key] !== reference[key])
              throw new Error(`${theme} header ${key} differs from Grok Bot: ${header[key]}`);
          }
          if (long) headers.push({ theme, ...header });
          if (!long) {
            // Match the attached crop: the outgoing bubble starts inside the header fade.
            await run(() => {
              const viewport = document.querySelector(".conversation-scroll");
              viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
              const bubble = document.querySelector('.message-bubble[data-role="user"]');
              viewport.scrollTop += bubble.getBoundingClientRect().top - 36;
            });
            await pause(200);
            fs.writeFileSync(
              path.join(process.env.CHAT_GRADIENT_ARTIFACTS, `${theme}-short.png`),
              (await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 190 })).toPNG()
            );
            continue;
          }
          for (const role of ["user", "assistant"]) {
            const positioned = await win.webContents.executeJavaScript(`(() => {
            const viewport = document.querySelector('.conversation-scroll');
            viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
            const bubbles = [...document.querySelectorAll('.message-bubble[data-role="${role}"]')];
            const bubble = bubbles.find(node => node.getBoundingClientRect().height > 100);
            if (!bubble) throw new Error('No visible ${role} bubble');
            const id = bubble.closest('[data-message-id]').dataset.messageId;
            viewport.scrollTop += bubble.getBoundingClientRect().top - 20;
            return id;
          })()`);
            await pause(300);
            const bounds = await win.webContents.executeJavaScript(`(() => {
            const b = document.querySelector('[data-message-id="${positioned}"] .message-bubble').getBoundingClientRect();
            return { x: Math.floor(${role === "assistant" ? "b.left + 8" : "b.right - 8"}), top: b.top, bottom: b.bottom };
          })()`);
            if (Math.abs(bounds.top - 20) > 1 || bounds.bottom < 85)
              throw new Error(`Incorrect probe geometry: ${JSON.stringify(bounds)}`);
            const shot = await win.webContents.capturePage({
              x: 0,
              y: 0,
              width: 1200,
              height: 260,
            });
            fs.writeFileSync(
              path.join(process.env.CHAT_GRADIENT_ARTIFACTS, `${theme}-${role}.png`),
              shot.toPNG()
            );
            const bitmap = shot.toBitmap();
            const size = shot.getSize();
            const scale = size.width / 1200;
            const sample = (y) =>
              bitmap[(Math.floor(y * scale) * size.width + Math.floor(bounds.x * scale)) * 4];
            const pixels = Array.from({ length: 48 }, (_, i) => sample(i + 28));
            const maxJump = Math.max(
              ...pixels.slice(1).map((value, i) => Math.abs(value - pixels[i]))
            );
            reports.push({ theme, role, maxJump, at43: sample(43), at44: sample(44) });
            if (role === "user" && Math.abs(pixels[0] - pixels.at(-1)) < 15)
              throw new Error("Expected a visible header fade over the outgoing bubble");
          }
        }
      }
      // Adjacent rows inside a bubble must blend continuously across the old 44px seam.
      // A 61px fade can change by up to ceil(255 / 61) levels per pixel, plus
      // one level for Chromium's dithering. The duplicate fade jumps by 19–86.
      if (reports.some((report) => report.maxJump > 6))
        throw new Error("Header fade has an abrupt luminance jump");
      fs.writeFileSync(
        path.join(process.env.CHAT_GRADIENT_DIR, "results.json"),
        JSON.stringify({ headers, reports })
      );
    } catch (error) {
      fs.writeFileSync(
        path.join(process.env.CHAT_GRADIENT_DIR, "results.json"),
        JSON.stringify({ headers, reports, error: error.message })
      );
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
