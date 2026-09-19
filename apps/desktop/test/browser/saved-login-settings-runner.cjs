const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const output = process.env.SAVED_LOGIN_TEST_OUTPUT;
if (!output || !process.env.SAVED_LOGIN_TEST_URL)
  throw Error("Set the isolated fixture URL and output directory");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 1100,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  const deadline = setTimeout(() => { console.error("Settings fixture exceeded 45 seconds"); app.exit(1); }, 45_000);
  win.webContents.on("console-message", (_event, _level, message) => console.log(message));
  try {
    await win.loadURL(process.env.SAVED_LOGIN_TEST_URL);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const button = name => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === name);
      const check = (condition, message) => { if (!condition) throw Error(message); };
      async function until(predicate, stage) {
        for (let i = 0; i < 200; i++) { if (predicate()) { console.log('Passed: ' + stage); return; } await wait(20); }
        throw Error('Settings UI timed out: ' + stage);
      }
      await until(() => button('Choose 1Password account'), 'mount');
      button('Choose 1Password account').click();
      await until(() => !button('Connect vault').disabled, 'account choice');
      button('Connect vault').click();
      await until(() => document.querySelector('[aria-label="Always allow saved logins in OpenTeam"]'), 'connect');
      const permission = () => document.querySelector('[aria-label="Always allow saved logins in OpenTeam"]');
      check(!permission().checked, 'New connection broadened permissions');
      check(document.body.textContent.includes('2 logins'), 'Missing directory count');
      permission().click();
      await until(() => permission().checked && !permission().disabled, 'enable connection');
      check(window.fixtureCalls.some(c => c.action === 'always-allow' && c.alwaysAllow === true), 'Permission IPC missing');
      window.fixtureSyncFailure = true;
      button('Sync').click();
      await until(() => document.body.textContent.includes('sync failed'), 'failed sync');
      window.fixtureSyncFailure = false;
      button('Sync').click();
      await until(() => !document.body.textContent.includes('sync failed') && document.body.textContent.includes('3 logins'), 'sync recovery');
      button('View saved logins').click();
      await until(() => document.body.textContent.includes('Fixture login'), 'directory');
      check(document.querySelectorAll('input[type="checkbox"]').length === 2, 'Broker showed legacy per-item grants');
      button('Renew access').click();
      await wait(0);
      await until(() => !button('Renew access').disabled, 'renewal');
      check(!document.body.textContent.includes('Fixture login'), 'Renewal retained stale credential metadata');
      check(window.fixtureCalls.some(c => c.action === 'connect' && c.input.connectionId === '1password:fixture-account:fixture-vault'), 'Renewal lost connection identity');
      for (const mode of ['permission', 'completion-pending', 'delivery-indeterminate', 'cancel']) {
        window.fixtureMode = mode;
        button('Connect vault').click();
        if (mode === 'cancel') {
          await until(() => button('Cancel setup'), 'cancel control');
          button('Cancel setup').click();
        }
        const expectedError = { permission: 'Manage Vault', 'completion-pending': 'registration could not be confirmed', 'delivery-indeterminate': 'previous setup', cancel: 'cancelled' }[mode];
        await until(() => !button('Connect vault').disabled && document.querySelector('[role="alert"]')?.textContent.includes(expectedError), mode);
        check(!!button('Retry connection completion') === (mode === 'completion-pending'), 'Wrong completion action for ' + mode);
        check(!!button('I reviewed the service accounts in 1Password — restart setup') === (mode === 'delivery-indeterminate'), 'Wrong restart action for ' + mode);
        if (mode === 'permission') check(document.querySelector('[role="alert"]').textContent.includes('Manage Vault'), 'Permission failure was not actionable');
        if (mode === 'cancel') check(document.querySelector('[role="alert"]').textContent.includes('cancelled'), 'Cancellation not rendered');
      }
      window.fixtureMode = undefined;
      button('Disconnect vault').click();
      await until(() => !permission(), 'disconnect');
      button('Connect vault').click();
      await until(() => permission(), 'reconnect');
      check(!permission().checked, 'Reconnect retained an old permission');
      return { connection: true, defaultAsk: true, permissionToggle: true, syncFailureRecovery: true, renewal: true, typedFailures: 3, cancellation: true, disconnectReconnect: true, calls: window.fixtureCalls.length };
    })()`);
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(
      path.join(output, "settings.png"),
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  }
});
