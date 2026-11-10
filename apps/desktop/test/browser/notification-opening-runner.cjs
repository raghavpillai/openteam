const { app, BrowserWindow, ipcMain, Notification } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const directory = process.argv[3];
const { DesktopNotificationManager, parseNotificationTarget } = require(
  path.join(directory, "notifications.cjs")
);
app.setPath("userData", path.join(directory, "profile"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app
  .whenReady()
  .then(async () => {
    const source = fs.readFileSync(process.argv[4], "utf8");
    const invokeChannels = new Set(
      [...source.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((match) => match[1])
    );
    for (const channel of invokeChannels) {
      ipcMain.handle(channel, () => {
        if (channel === "openteam:notifications:status")
          return { supported: true, authorized: true, settingsAvailable: false };
        if (channel.includes("activity")) return { active: false, idleSeconds: 0 };
        if (channel.includes("updates"))
          return { status: "up-to-date", currentVersion: "0.0.14", latestVersion: null };
        if (channel.includes("auth:read"))
          return { token: null, persistence: "disk", backend: "fixture" };
        return {};
      });
    }
    const win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 900,
      webPreferences: { backgroundThrottling: false, preload: path.join(directory, "preload.cjs") },
    });
    const errors = [];
    win.webContents.on("preload-error", (_event, _path, error) => errors.push(error.message));
    win.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    let clock = 10000;
    const manager = new DesktopNotificationManager(
      {
        isFocused: () => false,
        isSupported: () => true,
        setBadge() {},
        deliver(event) {
          // Exercise Electron's native click event and the shipping preload bridge
          // without showing a banner in the developer's Notification Center.
          const native = new Notification({ title: event.title, body: event.body, silent: true });
          native.once("click", () =>
            win.webContents.send("openteam:notification-click", parseNotificationTarget(event))
          );
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
    const js = (source) => win.webContents.executeJavaScript(source);
    const until = async (source, timeout = 8000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await js(source)) return;
        await pause(25);
      }
      throw new Error(`Timed out: ${source}`);
    };
    const check = async (source, message) => {
      if (!(await js(source))) throw new Error(message);
    };
    const visible = (id, thread = false) => `(() => {
    const row = document.querySelector('[data-${thread ? "thread-" : ""}message-id="${id}"]');
    const bounds = row?.getBoundingClientRect();
    return bounds?.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight
      && !row.closest('[aria-hidden="true"]');
  })()`;
    const selectOther = () =>
      js(
        `document.querySelector('[data-channel-id="' + notificationFixture.otherId + '"] button').click()`
      );
    const readCalls = `notificationFixture.calls.filter(c => c.kind === 'read' && c.channelId === notificationFixture.channelId)`;
    const passed = [];
    let current = "startup";
    try {
      for (const theme of ["dark", "light"]) {
        const test = async (name, body) => {
          current = `${theme}: ${name}`;
          manager.clear();
          await win.loadURL(`${process.argv[2]}?theme=${theme}`);
          await until(visible("other-message"));
          await body();
          if (errors.length) throw new Error(errors.join("\n"));
          passed.push(current);
        };
        await test("ordinary notification opens its exact older message", async () => {
          await js("notificationFixture.announce(25)");
          await until(visible("notice-25"));
          await until(`${readCalls}.some(c => c.sequence === '25')`);
          await check(
            `${readCalls}.every(c => c.sequence === '25' && c.activity === '0')`,
            "Read exceeded the notified message"
          );
          await check(
            "notificationFixture.bridgeTargets.at(-1).messageId === 'notice-25'",
            "Bridge lost the message ID"
          );
        });
        await test("sequence-only banner resolves outside the latest page", async () => {
          await js("notificationFixture.announce(25, true)");
          await until(visible("notice-25"));
          await check(
            "!notificationFixture.bridgeTargets.at(-1).messageId",
            "Legacy fixture unexpectedly supplied an ID"
          );
        });
        await test("thread notification opens its actual reply", async () => {
          await js("notificationFixture.announce(25, false, true)");
          await until(visible("notice-25", true));
        });
        await test("successive notifications focus replies within the same thread", async () => {
          await js("notificationFixture.prepareThread([25, 26])");
          await js("notificationFixture.announce(25, false, true)");
          await until(visible("notice-25", true));
          await js("notificationFixture.announce(26, false, true)");
          await until(visible("notice-26", true));
        });
        await test("successive notifications switch between different threads", async () => {
          await js(
            "notificationFixture.prepareThread([25, 26]); notificationFixture.prepareThread([160], 159)"
          );
          await js("notificationFixture.announce(25, false, true)");
          await until(visible("notice-25", true));
          await js("notificationFixture.announce(160, false, true, 159)");
          await until(visible("notice-160", true));
          await js("notificationFixture.announce(26, false, true)");
          await until(visible("notice-26", true));
        });
        await test("slow context shows progress and defers read acknowledgement", async () => {
          await js(
            "notificationFixture.control({contextDelay: 1200}); notificationFixture.announce(25)"
          );
          await until("document.querySelector('[data-notification-opening][role=status]')");
          await pause(300);
          await check(`${readCalls}.length === 0`, "Read acknowledged before the message loaded");
          await until(visible("notice-25"));
          await until(`${readCalls}.some(c => c.sequence === '25')`);
          await check(
            "!document.querySelector('[data-notification-opening]')",
            "Progress remained after completion"
          );
        });
        await test("slow activity hydration does not delay the target", async () => {
          await js(
            "notificationFixture.control({stateDelay: 2500}); notificationFixture.announce(25)"
          );
          await until(visible("notice-25"), 1500);
        });
        await test("cached context opens without another context request", async () => {
          await js("notificationFixture.announce(25)");
          await until(visible("notice-25"));
          await js(
            "notificationFixture.control({contextDelay: 2500, historyDelay: 2500}); notificationFixture.announce(26)"
          );
          await until(visible("notice-26"), 1500);
          await check(
            "!notificationFixture.calls.some(c => c.messageId === 'notice-26')",
            "Cached target fetched context again"
          );
        });
        await test("newer same-channel tap supersedes a delayed older tap", async () => {
          await js(
            "notificationFixture.control({contextDelay: 1000}); notificationFixture.announce(25)"
          );
          await until("notificationFixture.calls.some(c => c.messageId === 'notice-25')");
          await js(
            "notificationFixture.control({contextDelay: 10}); notificationFixture.announce(160)"
          );
          await until(visible("notice-160"));
          await pause(1150);
          await check(visible("notice-160"), "Stale context replaced the newer notification");
          await check(
            `${readCalls}.every(c => c.sequence !== '25')`,
            "Superseded target was acknowledged"
          );
        });
        await test("switching bots cancels a delayed notification", async () => {
          await js(
            "notificationFixture.control({contextDelay: 800}); notificationFixture.announce(25)"
          );
          await until("notificationFixture.calls.some(c => c.messageId === 'notice-25')");
          await selectOther();
          await pause(1000);
          await check(visible("other-message"), "Old request navigated back to the notified bot");
          await check(
            "!document.querySelector('[data-notification-opening]')",
            "Cancelled notification left progress visible"
          );
          await check(`${readCalls}.length === 0`, "Cancelled conversation was acknowledged");
        });
        await test("a twelve-tap burst settles on the final target under reordered responses", async () => {
          for (const number of [25, 65, 85, 45, 105, 55, 75, 35, 95, 115, 15]) {
            await js(
              `notificationFixture.control({contextDelay: ${500 + number}}); notificationFixture.announce(${number})`
            );
            await pause(10);
          }
          await js(
            "notificationFixture.control({contextDelay: 10}); notificationFixture.announce(100)"
          );
          await until(visible("notice-100"));
          await pause(900);
          await check(
            visible("notice-100"),
            "Reordered burst response replaced the final selection"
          );
          await check(
            "notificationFixture.bridgeTargets.length === 12",
            "Burst dropped a bridge event"
          );
        });
        await test("failed context offers a working retry", async () => {
          await js(
            "notificationFixture.control({contextFailures: 1}); notificationFixture.announce(25)"
          );
          await until("document.querySelector('[data-notification-opening][role=alert]')");
          await check(`${readCalls}.length === 0`, "Failed notification was acknowledged");
          await js("document.querySelector('[data-notification-opening] button').click()");
          await until(visible("notice-25"));
          await check(
            "notificationFixture.calls.filter(c => c.messageId === 'notice-25').length === 2",
            "Retry did not repeat the failed request"
          );
        });
        await test("a late failure stays cancelled after switching bots", async () => {
          await js(
            "notificationFixture.control({contextDelay: 600, contextFailures: 1}); notificationFixture.announce(25)"
          );
          await until("notificationFixture.calls.some(c => c.messageId === 'notice-25')");
          await selectOther();
          await pause(850);
          await check(
            "!document.querySelector('[data-notification-opening]')",
            "Stale failure reopened the notification error"
          );
          await check(visible("other-message"), "Failure changed the selected conversation");
        });
        await test("a new message replaces an older context window", async () => {
          await js("notificationFixture.announce(25)");
          await until(visible("notice-25"));
          await js("notificationFixture.announce(182)");
          await until(visible("notice-182"));
          await check(
            "notificationFixture.calls.some(c => c.messageId === 'notice-182')",
            "Unloaded newest message skipped context hydration"
          );
        });
        await test("late latest-page hydration preserves the notified target", async () => {
          await js(
            "notificationFixture.control({historyDelay: 800}); notificationFixture.announce(25)"
          );
          await until(visible("notice-25"));
          await pause(1100);
          await check(
            visible("notice-25"),
            "Latest-page response removed the older notification target"
          );
        });
        await test("jumping to latest cancels a pending notification", async () => {
          await js("notificationFixture.announce(25)");
          await until(visible("notice-25"));
          await js(
            "notificationFixture.control({contextDelay: 800}); notificationFixture.announce(80)"
          );
          await until("notificationFixture.calls.some(c => c.messageId === 'notice-80')");
          await js("document.querySelector('[aria-label=\"Jump to latest message\"]').click()");
          await until(visible("notice-180"));
          await pause(1000);
          await check(visible("notice-180"), "Delayed notification overrode jump to latest");
          await check(
            "!document.querySelector('[data-notification-opening]')",
            "Latest navigation left progress visible"
          );
        });
        await test("legacy channel-only click opens a loaded latest message", async () => {
          const channelId = await js("notificationFixture.channelId");
          win.webContents.send("openteam:notification-click", { channelId });
          await until(visible("notice-180"));
        });
        await test("malformed click targets are rejected by preload", async () => {
          const channelId = await js("notificationFixture.channelId");
          for (const payload of [
            null,
            [],
            { channelId, messageId: "" },
            { channelId, messageSequence: "invalid" },
          ]) {
            win.webContents.send("openteam:notification-click", payload);
          }
          await pause(150);
          await check(
            "notificationFixture.bridgeTargets.length === 0",
            "Malformed target escaped preload validation"
          );
          await check(visible("other-message"), "Malformed target changed conversations");
        });
        await test("reaction activity is acknowledged while an already-read bot stays open", async () => {
          await js("notificationFixture.announce(180)");
          await until(visible("notice-180"));
          await until(`${readCalls}.some(c => c.sequence === '180')`);
          await js("notificationFixture.reaction()");
          await until(`${readCalls}.some(c => c.activity === '12')`);
        });
      }
      fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed }));
    } catch (error) {
      const state = await js(
        "({calls:window.notificationFixture?.calls, targets:window.notificationFixture?.bridgeTargets, text:document.body.innerText.slice(-2000)})"
      ).catch(() => null);
      fs.writeFileSync(
        path.join(directory, "result.json"),
        JSON.stringify({ error: `${current}: ${error.message}`, passed, errors, state })
      );
    } finally {
      win.destroy();
      app.quit();
    }
  })
  .catch((error) => {
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ error: error.message }));
    app.quit();
  });
