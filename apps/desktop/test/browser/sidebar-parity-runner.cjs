const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.SIDEBAR_TEST_DIR, "profile"));
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 800,
      webPreferences: { backgroundThrottling: false },
    });
    const run = (fn) => win.webContents.executeJavaScript("(" + fn.toString() + ")()");
    const wait = () => new Promise((resolve) => setTimeout(resolve, 250));
    const reports = [];
    try {
      for (const query of ["", "?read=1", "?count=6&read=1", "?count=300"]) {
        await win.loadURL(process.env.SIDEBAR_TEST_URL + query);
        for (let i = 0; i < 100; i++) {
          if (await run(() => !!document.querySelector("[data-scroll-fade-bottom]"))) break;
          await wait();
        }
        await wait();
        reports.push(
          await run(async () => {
            const check = (ok, message) => {
              if (!ok) throw new Error(message);
            };
            const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
            const nav = document.querySelector("[data-scroll-fade-bottom]");
            const params = new URLSearchParams(location.search);
            const short = params.get("count") === "6";
            const read = params.has("read");
            check(
              nav.dataset.scrollFadeBottom === String(!short),
              "Bottom fade must track overflow independently of unread state"
            );
            check(nav.dataset.scrollFadeTop === "false", "No top fade at start");
            check(
              !!document.querySelector('[data-more-unreads="below"]') === !read,
              "Bottom unread pill"
            );
            const sidebar = document.querySelector("[data-sidebar]");
            const search = document.querySelector('button[aria-label="Search"]');
            const rosterRows = Array.from(nav.querySelectorAll("[data-channel-id]")).slice(0, 6);
            let previousTop;
            for (const entry of rosterRows) {
              const row = entry.querySelector("button");
              const title = row.querySelector(".truncate");
              const rect = row.getBoundingClientRect();
              const avatar = row.firstElementChild.getBoundingClientRect();
              check(
                avatar.width === 36 && avatar.height === 36,
                "Bots and groups share a 36px avatar slot"
              );
              check(
                title.getBoundingClientRect().left - sidebar.getBoundingClientRect().left === 64,
                "Every conversation title starts at x=64"
              );
              check(getComputedStyle(title).fontSize === "14px", "Conversation name is 14px");
              check(rect.height === 54, "Row height matches reference");
              if (previousTop !== undefined)
                check(rect.top - previousTop === 58, "Row spacing matches reference");
              previousTop = rect.top;
              check(
                Math.abs(rect.right - search.getBoundingClientRect().right) < 1,
                "Row right edge aligns with search, including short lists"
              );
              const preview = row.querySelector(".block.truncate");
              if (preview) {
                check(getComputedStyle(preview).fontSize === "13px", "Preview is 13px");
                check(
                  preview.getBoundingClientRect().left === title.getBoundingClientRect().left,
                  "Title and preview share an X position"
                );
              }
            }
            const glyph = rosterRows[0].querySelector("svg.robot-avatar");
            check(
              glyph.getBoundingClientRect().width === 45,
              "Robot artwork compensates for internal SVG padding"
            );
            for (const group of nav.querySelectorAll("[data-group-avatar]")) {
              const box = group.getBoundingClientRect();
              const user = group.querySelector("[data-group-avatar-user]").getBoundingClientRect();
              const bots = Array.from(group.querySelectorAll("[data-group-avatar-bot]"));
              check(user.top === box.top, "Group user badge starts at top");
              if (bots.length === 2) {
                check(
                  user.width === 20 && user.left === box.left + 8,
                  "20px user badge centered above bots"
                );
                const left = bots[0].getBoundingClientRect(),
                  right = bots[1].getBoundingClientRect();
                check(left.width === 20 && right.width === 20, "Two matching 20px bot badges");
                check(
                  left.left === box.left && right.right === box.right,
                  "Bot badges sit at opposite bottom corners"
                );
                check(
                  left.bottom === box.bottom && right.bottom === box.bottom,
                  "Bot badges share baseline"
                );
              } else if (bots.length === 1) {
                const bot = bots[0].getBoundingClientRect();
                check(
                  user.width === 24 && user.left === box.left,
                  "Single-bot group has 24px user at upper left"
                );
                check(
                  bot.width === 24 && bot.right === box.right && bot.bottom === box.bottom,
                  "Single-bot group has 24px bot at lower right"
                );
              } else {
                check(user.width === 36, "Empty group retains a full-size account avatar");
              }
            }
            if (!read) {
              const dot = document.querySelector('[aria-label="Unread activity"]');
              const row = dot.closest("button");
              const bounds = row.getBoundingClientRect(),
                badge = dot.getBoundingClientRect();
              check(
                Math.abs(bounds.right - badge.right - 8) < 1,
                "Unread dot must be right aligned"
              );
              check(
                Math.abs(bounds.y + bounds.height / 2 - badge.y - badge.height / 2) < 1,
                "Unread dot must be vertically centered"
              );
              check(
                getComputedStyle(row.querySelector(".truncate")).fontWeight === "500",
                "Unread name retains the same medium weight as other rows"
              );
              document.querySelector('[data-more-unreads="below"]').click();
              await pause();
              check(nav.scrollTop > 0, "Bottom unread pill must scroll");
              check(
                !!document.querySelector('[data-more-unreads="above"]'),
                "Top unread pill after jump"
              );
              document.querySelector('[data-more-unreads="above"]').click();
              await pause();
              const target = document.querySelector('[data-channel-id="channel-2"]');
              check(
                target && target.getBoundingClientRect().bottom > nav.getBoundingClientRect().top,
                "Top pill reveals unread target"
              );
            }
            nav.scrollTop = nav.scrollHeight;
            await pause();
            check(nav.dataset.scrollFadeBottom === "false", "Bottom fade disappears at end");
            check(nav.dataset.scrollFadeTop === String(!short), "Top fade follows overflow");
            nav.scrollTop = 0;
            await pause();
            check(
              !document.querySelector(
                '[aria-label="Expand sidebar"], [aria-label="Toggle compact sidebar"]'
              ),
              "No sidebar toggle icons"
            );
            const avatar = document.querySelector("[data-sidebar-account-avatar]");
            const toggle = () =>
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true }));
            const widths = [];
            toggle();
            const started = performance.now();
            while (performance.now() - started < 220) {
              await new Promise(requestAnimationFrame);
              widths.push(avatar.getBoundingClientRect().width);
              check(
                document.querySelector("[data-sidebar-account-avatar]") === avatar,
                "Profile avatar must not remount on resize"
              );
            }
            check(
              widths.some((width) => width > 28.1 && width < 35.9),
              "Profile scales through intermediate sizes"
            );
            check(
              Math.abs(avatar.getBoundingClientRect().width - 36) < 0.1,
              "Compact profile ends at 36px"
            );
            const compactNav = document.querySelector("[data-scroll-fade-bottom]");
            check(
              compactNav.dataset.scrollFadeBottom === String(!short),
              "Compact overflow fade preserved"
            );
            if (!read) {
              const arrow = document.querySelector('[data-more-unreads="below"]');
              check(
                arrow && arrow.getBoundingClientRect().width === 32,
                "Compact unread arrow remains a 32px circle"
              );
              arrow.click();
              await pause();
              check(compactNav.scrollTop > 0, "Compact unread arrow navigates");
              check(
                !!document.querySelector('[data-more-unreads="above"]'),
                "Compact top unread arrow preserved"
              );
              document.querySelector('[data-more-unreads="above"]').click();
              await pause();
              const unread = document.querySelector('[data-compact-channel-id="channel-2"]');
              check(
                unread &&
                  unread.getBoundingClientRect().bottom > compactNav.getBoundingClientRect().top,
                "Compact unread jump reveals target even with virtualization"
              );
            }
            compactNav.scrollTop = compactNav.scrollHeight;
            await pause();
            check(compactNav.dataset.scrollFadeBottom === "false", "Compact fade clears at bottom");
            toggle();
            await new Promise((resolve) => setTimeout(resolve, 220));
            check(
              document.querySelector("[data-sidebar-account-avatar]") === avatar,
              "Profile remains mounted when expanding"
            );
            check(
              Math.abs(avatar.getBoundingClientRect().width - 28) < 0.1,
              "Expanded profile smoothly shrinks to 28px"
            );
            return {
              query: location.search,
              font: getComputedStyle(document.querySelector("[data-scroll-fade-bottom]"))
                .fontFamily,
            };
          })
        );
        if (!query) {
          fs.writeFileSync(
            process.env.SIDEBAR_TEST_SCREENSHOT,
            (await win.webContents.capturePage()).toPNG()
          );
          await run(() =>
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true }))
          );
          await wait();
          fs.writeFileSync(
            process.env.SIDEBAR_TEST_SCREENSHOT.replace(".png", "-compact.png"),
            (await win.webContents.capturePage()).toPNG()
          );
          await run(() =>
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true }))
          );
          await wait();
        }
      }
      fs.writeFileSync(
        path.join(process.env.SIDEBAR_TEST_DIR, "results.json"),
        JSON.stringify({ reports })
      );
    } catch (error) {
      fs.writeFileSync(
        path.join(process.env.SIDEBAR_TEST_DIR, "results.json"),
        JSON.stringify({ error: error.message })
      );
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
