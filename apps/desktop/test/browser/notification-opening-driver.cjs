// Notification taps through the real preload bridge, main-process notification manager and
// Electron click event into the full App on notification-opening.tsx.
const { ipcMain, Notification } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async (fixture) => {
  const { directory, open, js, until, check, pause, errors } = fixture;
  const { DesktopNotificationManager, parseNotificationTarget } = require(path.join(directory, "notifications.cjs"));
  const preload = fs.readFileSync(path.join(__dirname, "../../src/preload/index.ts"), "utf8");
  for (const channel of new Set([...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1])))
    ipcMain.handle(channel, () => {
      if (channel === "openteam:notifications:status") return { supported: true, authorized: true, settingsAvailable: false };
      if (channel.includes("activity")) return { active: false, idleSeconds: 0 };
      if (channel.includes("updates")) return { status: "up-to-date", currentVersion: "0.0.14", latestVersion: null };
      if (channel.includes("auth:read")) return { token: null, persistence: "disk", backend: "fixture" };
      return {};
    });
  const win = open({ width: 1100, height: 900, preload: path.join(directory, "preload.cjs") });
  let clock = 10000;
  const manager = new DesktopNotificationManager(
    {
      isFocused: () => false,
      isSupported: () => true,
      setBadge() {},
      deliver(event) {
        // Electron's native click event without a banner in the developer's Notification Center.
        const native = new Notification({ title: event.title, body: event.body, silent: true });
        native.once("click", () => win.webContents.send("openteam:notification-click", parseNotificationTarget(event)));
        native.emit("click");
      },
    },
    () => clock
  );
  ipcMain.on("openteam:notifications:sync", (_event, snapshot) => {
    clock += 6000;
    manager.sync(snapshot);
  });
  ipcMain.on("openteam:notifications:clear", () => manager.clear());
  const visible = (id, thread = false) => `(() => {
    const row = document.querySelector('[data-${thread ? "thread-" : ""}message-id="${id}"]');
    const bounds = row?.getBoundingClientRect();
    return bounds?.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight
      && !row.closest('[aria-hidden="true"]');
  })()`;
  const readCalls = `notificationFixture.calls.filter(c => c.kind === 'read' && c.channelId === notificationFixture.channelId)`;
  const progressGone = `!document.querySelector('[data-notification-opening]')`;
  const reports = [];
  const test = async (name, body) => {
    manager.clear();
    await win.loadURL(fixture.url);
    await until(visible("other-message"));
    try {
      await body();
      // The file-preview redesign (#315) logs a React NaN-height style warning in this fixture;
      // it is unrelated to notification opening, so it doesn't fail these checks.
      const real = errors.filter((e) => !/is an invalid value for the `%s` css style property/.test(e));
      if (real.length) throw new Error(real.join("\n"));
    } catch (error) {
      const state = await js(`({calls:notificationFixture.calls, targets:notificationFixture.bridgeTargets, text:document.body.innerText.slice(-2000)})`).catch(() => null);
      throw new Error(`${name}: ${error.message}\n${JSON.stringify(state)}`);
    }
    reports.push(name);
  };

  await test("ordinary notification opens its exact older message", async () => {
    await js("notificationFixture.announce(25)");
    await until(visible("notice-25"));
    await until(`${readCalls}.some(c => c.sequence === '25')`);
    await check(`${readCalls}.every(c => c.sequence === '25' && c.activity === '0')`, "Read exceeded the notified message");
    await check("notificationFixture.bridgeTargets.at(-1).messageId === 'notice-25'", "Bridge lost the message ID");
  });
  await test("successive notifications switch between different threads", async () => {
    await js("notificationFixture.prepareThread([25, 26]); notificationFixture.prepareThread([160], 159)");
    await js("notificationFixture.announce(25, true)");
    await until(visible("notice-25", true));
    await js("notificationFixture.announce(160, true, 159)");
    await until(visible("notice-160", true));
    await js("notificationFixture.announce(26, true)");
    await until(visible("notice-26", true));
  });
  await test("slow context shows progress and defers read acknowledgement", async () => {
    await js("notificationFixture.control({contextDelay: 1200}); notificationFixture.announce(25)");
    await until("document.querySelector('[data-notification-opening][role=status]')");
    await pause(300);
    await check(`${readCalls}.length === 0`, "Read acknowledged before the message loaded");
    await until(visible("notice-25"));
    await until(`${readCalls}.some(c => c.sequence === '25')`);
    await check(progressGone, "Progress remained after completion");
  });
  await test("newer same-channel tap supersedes a delayed older tap", async () => {
    await js("notificationFixture.control({contextDelay: 1000}); notificationFixture.announce(25)");
    await until("notificationFixture.calls.some(c => c.messageId === 'notice-25')");
    await js("notificationFixture.control({contextDelay: 10}); notificationFixture.announce(160)");
    await until(visible("notice-160"));
    await pause(1150);
    await check(visible("notice-160"), "Stale context replaced the newer notification");
    await check(`${readCalls}.every(c => c.sequence !== '25')`, "Superseded target was acknowledged");
  });
  await test("switching bots cancels a delayed notification", async () => {
    await js("notificationFixture.control({contextDelay: 800}); notificationFixture.announce(25)");
    await until("notificationFixture.calls.some(c => c.messageId === 'notice-25')");
    await js(`document.querySelector('[data-channel-id="' + notificationFixture.otherId + '"] button').click()`);
    await pause(1000);
    await check(visible("other-message"), "Old request navigated back to the notified bot");
    await check(progressGone, "Cancelled notification left progress visible");
    await check(`${readCalls}.length === 0`, "Cancelled conversation was acknowledged");
  });
  await test("failed context offers a working retry", async () => {
    await js("notificationFixture.control({contextFailures: 1}); notificationFixture.announce(25)");
    await until("document.querySelector('[data-notification-opening][role=alert]')");
    await check(`${readCalls}.length === 0`, "Failed notification was acknowledged");
    await js("document.querySelector('[data-notification-opening] button').click()");
    await until(visible("notice-25"));
    await check("notificationFixture.calls.filter(c => c.messageId === 'notice-25').length === 2", "Retry did not repeat the failed request");
  });
  await test("late latest-page hydration preserves the notified target", async () => {
    await js("notificationFixture.control({historyDelay: 800}); notificationFixture.announce(25)");
    await until(visible("notice-25"));
    await pause(1100);
    await check(visible("notice-25"), "Latest-page response removed the older notification target");
  });
  await test("jumping to latest cancels a pending notification", async () => {
    await js("notificationFixture.announce(25)");
    await until(visible("notice-25"));
    await js("notificationFixture.control({contextDelay: 800}); notificationFixture.announce(80)");
    await until("notificationFixture.calls.some(c => c.messageId === 'notice-80')");
    await js("document.querySelector('[aria-label=\"Jump to latest message\"]').click()");
    await until(visible("notice-180"));
    await pause(1000);
    await check(visible("notice-180"), "Delayed notification overrode jump to latest");
    await check(progressGone, "Latest navigation left progress visible");
  });
  await test("reaction activity is acknowledged while an already-read bot stays open", async () => {
    await js("notificationFixture.announce(180)");
    await until(visible("notice-180"));
    await until(`${readCalls}.some(c => c.sequence === '180')`);
    await js("notificationFixture.reaction()");
    await until(`${readCalls}.some(c => c.activity === '12')`);
  });
  return { reports };
};
