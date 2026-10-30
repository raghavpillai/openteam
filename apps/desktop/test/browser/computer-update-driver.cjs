const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const BUSY = "Scout and Chief of Staff are still working. Update will be available when every agent is done.";
const REFUSAL = "Orion is still working. Nothing changed; try again when it's done.";
app
  .whenReady()
  .then(async () => {
    let win = new BrowserWindow({
      show: false,
      width: 806,
      height: 600,
      webPreferences: { backgroundThrottling: false },
    });
    let passed = 0;
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "error") console.error(message);
    });
    const js = (s) => win.webContents.executeJavaScript(s);
    const card = () => js(`(()=>{const el=document.querySelector('[data-update-state]');return {state:el?.dataset.updateState,text:el?.innerText,buttons:[...el.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),disabled:b.disabled,confirming:b.dataset.confirming==='true'}))}})()`);
    const assert = async (check, message) => {
      const value = await card();
      if (!check(value)) throw new Error(`${message}: ${JSON.stringify(value)}`);
      passed++;
    };
    const waitFor = async (check, message, timeout = 4_000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (check(await card())) break;
        await delay(50);
      }
      await assert(check, message);
    };
    const click = async (text) => {
      const point = await js(
        `(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!el) throw new Error('Click target missing: ${text}'); const b=el.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()`
      );
      win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await delay(120);
    };
    const shot = async (name) =>
      fs.writeFileSync(path.join(process.argv[3], name + ".png"), (await win.webContents.capturePage()).toPNG());
    const button = (value, text) => value.buttons.find((b) => b.text === text);

    await win.loadURL(process.argv[2]);
    for (let i = 0; i < 150 && !(await js("window.fixture?.ready")); i++) await delay(100);

    // An update is pending and every bot is idle: Update is offered, nothing to stop.
    await waitFor((v) => v.state === "ready", "pending update with idle bots is ready");
    await assert((v) => v.text.includes("Server 0.0.10") && v.text.includes("Update to 0.0.11"), "older compatible server offers the installed desktop release without update-feed data");
    if (!(await js(`document.body.innerText.includes('Desktop app 0.0.11') && document.querySelector('[data-settings-anchor="server-update"]')`)))
      throw new Error("Updates must show both desktop and server controls");
    passed++;
    await js(`document.querySelector('a[href="openteam://app/v1/settings?id=server-update"]').click()`);
    if (!(await js(`fixture.links.at(-1)==='openteam://app/v1/settings?id=server-update' && fixture.updates.length===0`)))
      throw new Error("The compatibility notice must link to server updates without starting one");
    passed++;
    await js(`fixture.desktop({latestVersion:'0.0.12',status:'available'})`);
    await assert(v=>v.state==='ready' && v.text.includes('Update to 0.0.11'), "a newer desktop feed must not update the server ahead of this desktop");
    await js(`fixture.desktop({latestVersion:null,status:'error',message:'Release feed unavailable'})`);
    await assert(v=>v.state==='ready', "a failed desktop update feed must not hide the server update");
    await js(`fixture.desktop({latestVersion:null,status:'up-to-date',message:null})`);
    await assert((v) => v.text.includes("openteam.example") && v.text.includes("What stays after updating?") && !v.text.includes("may remove packages"), "reference title and description");
    await assert((v) => v.buttons.length === 1 && button(v, "Update")?.disabled === false, "only Update, enabled");
    await js(`document.documentElement.dataset.theme='light'`);
    await delay(350);
    await shot("connected-server-light");
    await js(`document.documentElement.dataset.theme='dark'`);
    await delay(350);
    await shot("connected-server-dark");
    if (!(await js(`!document.querySelector('input') && !document.body.innerText.includes('SSH') && document.body.innerText.includes('openteam.example')`)))
      throw new Error("Connected-server card must have no separate SSH configuration");
    passed++;
    await shot("01-ready");

    // The installed release is current.
    await js(`fixture.server({currentVersion:"0.0.11"})`);
    await waitFor((v) => v.state === "up-to-date", "up to date");
    await assert((v) => v.text.includes("Your server matches desktop 0.0.11.") && v.buttons.length === 0, "matching-version banner, no buttons");
    await shot("02-up-to-date");
    await js(`fixture.server({currentVersion:"0.0.12"})`);
    await waitFor(v=>v.state==='up-to-date' && v.text.includes('newer than the installed desktop'), "newer servers are identified without offering a downgrade");
    await js(`fixture.server({currentVersion:"0.0.10"})`);
    await waitFor((v) => v.state === "ready", "pending again");

    // A bot starts working: the card names the first busy bot in sidebar order, Update waits.
    await js(`fixture.busy=[{botId:"b-chief",name:"Chief of Staff",runIds:["r1"]},{botId:"b-scout",name:"Scout",runIds:["r2"]}]`);
    await waitFor((v) => v.state === "busy", "busy after the next poll", 3_500);
    await assert((v) => v.text.includes(BUSY), "busy explanation names the busy bots in sidebar order");
    await assert((v) => v.buttons.map((b) => b.text).join("|") === "Stop Scout|Update", "Stop names Scout, the first busy bot in the sidebar");
    await assert((v) => button(v, "Update").disabled && !button(v, "Stop Scout").disabled, "Update disabled while busy");
    await shot("03-busy");

    // First click arms the stop; it resets on its own after 3 s.
    await click("Stop Scout");
    await assert((v) => button(v, "Click Again to Confirm")?.confirming === true, "armed stop asks to confirm");
    await js(`fixture.stops.length`).then((n) => { if (n !== 0) throw new Error("armed click stopped a bot"); passed++; });
    await shot("04-confirm-armed");
    await delay(3_200);
    await assert((v) => button(v, "Stop Scout")?.confirming === false, "confirm resets after 3 s");
    await js(`fixture.stops.length`).then((n) => { if (n !== 0) throw new Error("reset stopped a bot"); passed++; });

    // Second click within 3 s stops that bot; the button holds while the stop is in flight.
    await js(`fixture.stopDelayMs=900`);
    await click("Stop Scout");
    await click("Click Again to Confirm");
    await assert((v) => button(v, "Stop Scout")?.disabled === true, "stopping holds the button");
    await shot("05-stopping");
    await waitFor((v) => v.buttons.map((b) => b.text).join("|") === "Stop Chief of Staff|Update", "next busy bot offered after the stop");
    await js(`JSON.stringify(fixture.stops)`).then((s) => { if (s !== '["b-scout"]') throw new Error(`stops: ${s}`); passed++; });
    await shot("06-next-busy-bot");
    await js(`fixture.stopDelayMs=0`);
    await click("Stop Chief of Staff");
    await click("Click Again to Confirm");
    await waitFor((v) => v.state === "ready" && v.buttons.length === 1, "idle once every bot is stopped");

    // A bot started working after the check: the CLI's refusal names it and shows as it is.
    await js(`fixture.failUpdate=${JSON.stringify(REFUSAL)}`);
    await click("Update");
    await assert((v) => button(v, "Click Again to Confirm")?.confirming === true, "Update asks to confirm");
    await click("Click Again to Confirm");
    await waitFor((v) => v.text.includes(REFUSAL), "busy refusal shown");
    await assert((v) => !v.text.includes("The server update failed"), "refusal isn't called a failure");
    await shot("07-refused");

    // Update re-checks for work first, then updates every service together.
    await js(`fixture.failUpdate=null; fixture.server({status:"ready",message:null})`);
    const checks = await js(`fixture.busyChecks`);
    await click("Update");
    await click("Click Again to Confirm");
    await waitFor((v) => v.state === "updating" && v.buttons.length === 0, "Updating…");
    await assert((v) => v.text.includes("Pulling OpenTeam 0.0.11 container images"), "progress message");
    await js(`[fixture.busyChecks, JSON.stringify(fixture.updates)]`).then(([n, updates]) => {
      if (n <= checks) throw new Error("Update didn't re-check for busy bots");
      if (updates !== '[{"targetVersion":"0.0.11"},{"targetVersion":"0.0.11"}]') throw new Error(`updates: ${updates}`);
      passed += 2;
    });
    await shot("08-updating");
    await assert(v=>v.text.includes('Step 2 of 5') && v.text.includes('Downloading update'), "download milestone comes from the host phase");
    await js(`fixture.server({phase:'backing-up',message:'Backing up the database…'})`);
    await waitFor(v=>v.text.includes('Step 3 of 5') && v.text.includes('Protecting your data'), "backup milestone");
    await js(`fixture.server({phase:'future-phase',message:'Working on the update…'})`);
    await waitFor(v=>v.text.includes('Live progress') && !v.text.includes('Step 3'), "unknown phases do not invent progress");
    await js(`fixture.server({phase:'rolling-back',message:'Restoring the previous release…'})`);
    await waitFor(v=>v.text.includes('Recovering safely') && !v.text.includes('Step 5'), "rollback is presented as recovery, not successful progress");
    await js(`fixture.server({phase:'restarting',message:'Restarting services…'})`);
    await waitFor(v=>v.text.includes('Step 4 of 5'), "restart milestone");

    if (!(await js(`fixture.destinations.every(url=>url==='https://openteam.example/api/v0/system/update') && fixture.payloads.every(body=>JSON.stringify(body)==='{"targetVersion":"0.0.11"}')`)))
      throw new Error("Updates must target only the selected server through its API");
    passed++;
    await js(`fixture.offline=true`);
    await delay(1800);
    await assert(v=>v.state==='updating', "maintenance restart preserves update progress");
    await assert(v=>v.text.includes('Reconnecting to the server…') && v.text.includes('Step 4 of 5'), "reconnect keeps the last reported milestone visible");
    await js(`fixture.offline=false;fixture.versionOffline=true;fixture.server({status:'updated',phase:'complete',currentVersion:'0.0.11'})`);
    await delay(1700);
    await assert(v=>v.state==='updating', "completion waits for the live version endpoint to reconnect");
    await js(`fixture.versionOffline=false`);
    await js(`fixture.offline=false;fixture.server({status:'updated',phase:'complete',currentVersion:'0.0.11'})`);
    await waitFor(v=>v.state==='up-to-date', "reconnect discovers the completed release");
    // Destroy the renderer and window, then reopen while the server is still offline.
    await js(`fixture.server({status:'updating',phase:'restarting',currentVersion:'0.0.10',jobId:'resumed-job',safeToCloseDesktop:true})`);
    await waitFor(v=>v.state==='updating' && v.text.includes('Step 4 of 5'), "active job is saved before closing");
    app.on('window-all-closed', ()=>{});
    win.destroy();
    win = new BrowserWindow({show:false,width:806,height:700,webPreferences:{backgroundThrottling:false}});
    await win.loadURL(process.argv[2] + '?resume=offline');
    for(let i=0;i<150 && !(await js('window.fixture?.ready'));i++) await delay(100);
    await waitFor(v=>v.state==='updating' && v.text.includes('Last seen: Restarting services'), "reopening offline restores last known progress");
    await assert(v=>v.text.includes('Reconnecting to the server…') && v.buttons.length===0, "cached progress never starts a second update");
    await shot('reopened-offline');
    await js(`fixture.offline=false;fixture.server({status:'updated',phase:'complete',currentVersion:'0.0.11'})`);
    await waitFor(v=>v.state==='up-to-date', "live completion replaces cached progress");
    if(!(await js(`!localStorage.getItem('openteam:server-update:https://openteam.example') && fixture.updates.length===0`))) throw new Error('Completion must clear the cached active job without posting');
    passed++;
    await win.loadURL(process.argv[2] + '?resume=live');
    for(let i=0;i<150 && !(await js('window.fixture?.ready'));i++) await delay(100);
    await waitFor(v=>v.state==='updating' && v.text.includes('Checking server health'), "reopening sees updates started by another client");
    await win.loadURL(process.argv[2] + '?resume=complete');
    for(let i=0;i<150 && !(await js('window.fixture?.ready'));i++) await delay(100);
    await waitFor(v=>v.state==='up-to-date', "reopening after completion reads the running version");
    await js(`fixture.server({status:'unavailable',updaterAvailable:false,currentVersion:'0.0.10',message:'Run openteam start on the server to enable updates from the app.'})`);
    await waitFor(v=>v.state==='unavailable', "missing host updater shows recovery guidance");
    await assert(v=>v.text.includes('openteam start'), "recovery command names the server host");
    win.setSize(390, 520);
    await delay(150);
    if (!(await js(`document.documentElement.scrollWidth<=innerWidth && !document.querySelector('input')`)))
      throw new Error("Narrow card must fit without an SSH field");
    passed++;
    await shot("connected-server-narrow");

    win.setSize(806, 700);
    await win.loadURL(process.argv[2] + '?server');
    for (let i = 0; i < 150 && !(await js("window.fixture?.ready")); i++) await delay(100);
    for (let i = 0; i < 80 && !(await js(`document.querySelector('[aria-label="Connected server"]')?.textContent.includes('Server 0.0.10')`)); i++) await delay(50);
    await js(`document.querySelector('a[href="openteam://app/v1/settings?id=server-update"]').click()`);
    if (!(await js(`fixture.links.at(-1)==='openteam://app/v1/settings?id=server-update' && document.querySelector('[aria-label="Connected server"]').innerText.includes('Server 0.0.10') && !document.querySelector('[data-update-state]') && fixture.updates.length===0 && fixture.busyChecks===0`)))
      throw new Error("Server must show its version and link to Updates without update or stop controls");
    passed++;
    if (!(await js(`document.body.innerText.includes('Manage devices') && document.querySelector('[aria-label="Box display width"]')`)))
      throw new Error("Server must contain the server-wide device and bot display settings");
    passed++;
    await shot("server-settings");

    await win.loadURL(process.argv[2] + '?computer');
    for (let i = 0; i < 150 && !(await js("window.fixture?.ready")); i++) await delay(100);
    for (let i = 0; i < 80 && !(await js(`document.querySelector('[aria-label="Computer label"]')?.value==='This Mac'`)); i++) await delay(50);
    if (!(await js(`document.querySelector('[aria-label="Computer label"]').value==='This Mac' && document.querySelector('[aria-label="Use Messages"]') && !['Connected server','Manage devices','Box display','View updates'].some(label=>document.body.innerText.includes(label)) && !document.querySelector('[data-update-state]') && !fixture.requests.some(path=>path.includes('/system/') || path.endsWith('/machines') || path.endsWith('/computer-display'))`)))
      throw new Error("Computer must contain only the current computer's settings and make no server management requests");
    passed++;
    await shot("computer-settings");

    await win.loadURL(process.argv[2] + '?unknown');
    for (let i = 0; i < 150 && !(await js("window.fixture?.ready")); i++) await delay(100);
    await waitFor(v=>v.state==='unavailable', "an unreported server version must not appear current");
    await assert(v=>v.text.includes('Server version unknown') && !v.text.includes('Your server matches') && button(v,'Update')?.disabled, "unknown server displays uncertainty and disables updates");

    fs.writeFileSync(
      path.join(process.argv[3], "results.json"),
      JSON.stringify({ passed, scenarios: ["Updates contains desktop and server", "linked version notice", "older compatible server without feed", "feed failure", "server target stays on installed desktop", "up to date", "newer server", "busy + Stop first sidebar bot", "confirm arm and 3 s reset", "stopping", "next busy bot", "busy refusal", "updating", "Server summary links to Updates", "server-wide devices and display in Server", "Computer contains only the current machine", "unknown server"] }, null, 2)
    );
    console.log(`${passed} computer update card checks passed`);
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
