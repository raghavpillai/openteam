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
      const button = name => [...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.textContent.trim() === name);
      const check = (condition, message) => { if (!condition) throw Error(message); };
      async function until(predicate, stage) {
        for (let i = 0; i < 200; i++) { if (predicate()) { console.log('Passed: ' + stage); return; } await wait(20); }
        throw Error('Settings UI timed out: ' + stage);
      }
      const marketplace = new URLSearchParams(location.search).has('marketplace');
      if (marketplace) {
        await until(() => button('Connect 1Password'), 'marketplace mount');
        button('Connect 1Password').click();
      } else {
        await until(() => document.querySelector('[aria-label="Computer label"]')?.value === 'Fixture computer', 'computer settings mount');
        check(!document.body.textContent.includes('1Password'), '1Password remains in Computer settings');
        check(!document.body.textContent.includes('Saved logins'), 'Saved logins remain in Computer settings');
        check(!document.querySelector('input[type="password"]'), 'Token form remains in Computer settings');
        return { marketplace: false, computerSettingsOnly: true, noSavedLogins: true };
      }
      await until(() => document.querySelector('input[type="password"]'), 'manual token form');
      check(!document.body.textContent.includes('Shared with OpenTeam'), 'Dedicated vault name restriction remains');
      check(document.body.textContent.includes('existing vaults'), 'Existing vault instructions missing');
      check(!document.body.textContent.includes('CLI integration'), 'Automatic setup guidance remains');
      check(!button('Use a service account token instead'), 'Alternative setup option remains');
      const enterToken = async () => {
        const field = document.querySelector('input[type="password"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'ops_synthetic_manual_token');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        await until(() => !button('Connect 1Password').disabled, 'token entry');
      };
      await enterToken();
      window.fixtureMode = 'invalid';
      button('Connect 1Password').click();
      await until(() => document.querySelector('[role="alert"]'), 'invalid-token feedback');
      check(document.querySelector('input[type="password"]'), 'Failed import dismissed token entry');
      window.fixtureMode = 'cancel';
      button('Connect 1Password').click();
      await until(() => button('Cancel setup'), 'cancellation control');
      button('Cancel setup').click();
      await until(() => document.querySelector('[role="alert"]')?.textContent.includes('cancelled'), 'cancelled import');
      window.fixtureMode = undefined;
      button('Connect 1Password').click();
      const connection = () => document.querySelector('[aria-label="Connected 1Password vaults"]');
      await until(() => connection()?.textContent.includes('Existing Work Vault') && !document.querySelector('input[type="password"]'), 'connect and clear token');
      check(!document.body.textContent.includes('ops_synthetic_manual_token'), 'Token exposed in UI');
      window.fixtureSyncFailure = true;
      button('Sync').click();
      await until(() => document.body.textContent.includes('Could not sync'), 'failed sync');
      window.fixtureSyncFailure = false;
      button('Sync').click();
      await until(() => !document.body.textContent.includes('Could not sync'), 'sync recovery');
      button('View saved logins').click();
      await until(() => document.body.textContent.includes('Fixture login'), 'login directory');
      button('Renew access').click();
      await until(() => document.querySelector('input[type="password"]'), 'manual renewal');
      check(document.querySelector('input[type="password"]').value === '', 'Renewal retained secret');
      await enterToken();
      button('Connect 1Password').click();
      await until(() => connection() && !document.querySelector('input[type="password"]'), 'renew and clear token');
      button('Disconnect').click();
      await until(() => !connection(), 'disconnect');
      document.querySelector('[aria-label="Back to Marketplace"]').click();
      await until(() => button('Connect 1Password'), 'disconnected marketplace status');
      check(!button('Manage 1Password'), 'Disconnected vault still marked connected');
      window.fixtureMultipleVaults = true;
      button('Connect 1Password').click();
      await until(() => document.querySelector('input[type="password"]'), 'reconnect token form');
      await enterToken();
      button('Connect 1Password').click();
      await until(() => connection()?.textContent.includes('Existing Work Vault') && document.body.textContent.includes('Existing Family Vault'), 'reconnect multiple existing vaults');
      if (marketplace) {
        document.querySelector('[aria-label="Back to Marketplace"]').click();
        await until(() => button('Manage 1Password'), 'connected marketplace status');
        check(document.body.textContent.includes('1 installed'), 'Native connection missing from installed count');
        document.querySelector('[aria-label="Manage plugins"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
        await until(() => [...document.querySelectorAll('[role="menuitem"]')].some(el => el.textContent.trim() === 'Your plugins'), 'plugins menu');
        [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.trim() === 'Your plugins').click();
        await until(() => document.body.textContent.includes('Shared saved logins'), 'installed native connection');
        button('Manage 1Password').click();
        await until(() => connection(), 'reopen native connection');
      }
      return { marketplace, manualOnly: true, existingVaults: true, multipleVaults: true, invalidToken: true, cancellation: true, syncRecovery: true, manualRenewal: true, disconnectReconnect: true, noLocalRead: true };

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
