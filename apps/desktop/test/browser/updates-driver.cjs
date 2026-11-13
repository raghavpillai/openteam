// Desktop self-update, then the server update card, on the synthetic updates.tsx page.
const BUSY = "Scout and Chief of Staff are still working. Update will be available when every agent is done.";
const REFUSAL = "Orion is still working. Nothing changed; try again when it's done.";

module.exports = async (fixture) => {
  const { open, js, click, load, pause, button, errors } = fixture;
  const reports = [];
  const assert = async (source, message) => {
    if (!(await js(source))) throw new Error(message);
    reports.push(message);
  };

  open({ width: 806, height: 518 });
  await load();
  await assert(`document.querySelector('[data-desktop-update-badge="available"]')?.textContent.includes('Update')`, "update badge shows before opening the account menu");
  await click(`document.getElementById('account')`);
  await assert(`document.querySelector('[data-desktop-update-card]')?.textContent.includes('OpenTeam 0.47.0')`, "account menu card names the available release");
  await js(`fixture.failDownload=true`);
  await click(button("Download update"));
  await assert(`fixture.downloads===1&&document.querySelector('[role=alert]')?.textContent.includes('Could not download')&&!!${button("Download update")}`, "download failure shows an error and allows retry");
  await js(`fixture.failDownload=false`);
  await click(button("Download update"));
  await assert(`fixture.downloads===2 && fixture.installs===0`, "download does not restart the app");
  await assert(`document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')==='42'&&!${button("Download update")}`, "progress replaces the download action");
  await js(`fixture.emit({status:'downloaded',progress:100})`);
  await pause(300);
  await assert(`document.querySelector('[role=alertdialog]')?.textContent.includes('OpenTeam 0.47.0') && !document.querySelector('[role=menu]') && fixture.installs===0`, "ready dialog waits for restart confirmation");
  await click(button("Not now"));
  await assert(`fixture.installs===0 && !document.querySelector('[role=alertdialog]') && document.querySelector('[data-desktop-update-badge="downloaded"]')`, "Not now dismisses without restart and keeps the badge");
  await js(`fixture.emit({status:'downloaded'})`);
  await pause(100);
  await assert(`!document.querySelector('[role=alertdialog]')`, "repeated progress respects dismissal");
  await click(`document.getElementById('account')`);
  await click(button("Restart to update"));
  await assert(`!!document.querySelector('[role=alertdialog]')`, "account restart action reopens the dialog");
  await js(`fixture.failInstall=true`);
  await click(button("Restart to update"));
  await assert(`document.querySelector('[role=alert]')?.textContent.includes('Test restart failed') && !${button("Restart to update")}.disabled`, "failed restart is visible and retryable");
  await js(`fixture.failInstall=false; ${button("Restart to update")}.click(); ${button("Restart to update")}.click();`);
  await pause(100);
  await assert(`fixture.installs===2 && ${button("Restarting…")}.disabled`, "restart submits once while pending");

  await load("&compact");
  await click(`document.getElementById('account')`);
  await assert(`!!document.querySelector('[data-desktop-update-badge]') && !!${button("Download update")}`, "collapsed sidebar badge leads to the update action");
  await js(`fixture.emit({status:'error'})`);
  await assert(`!document.querySelector('[data-desktop-update-badge]')&&!document.querySelector('[data-desktop-update-card]')`, "a failed check does not claim an update");

  await load("&settings");
  await js(`fixture.emit({status:'error',failureKind:'feed-http-status',message:'HttpError: 504 '+'detail '.repeat(1000)+String.fromCharCode(10)+'XML: private release feed'})`);
  await assert(`(()=>{const e=document.querySelector('[data-settings-anchor~="update-status"] .line-clamp-2');return e.textContent.length<=180&&!e.textContent.includes('XML:');})()`, "long update errors are truncated without feed internals");
  await js(`fixture.emit({status:'downloaded',message:null,failureKind:null})`);
  await pause(250);
  await click(button("Not now"));
  await click(button("Restart to update"));
  await assert(`fixture.installs===0 && !!document.querySelector('[role=alertdialog]')`, "Settings restart opens confirmation");
  if (errors.length) throw new Error(errors.join("\n"));

  // Server update card. `card` reads its state, text and buttons.
  const card = () => js(`(()=>{const el=document.querySelector('[data-update-state]');return {state:el?.dataset.updateState,text:el?.innerText,buttons:[...el.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),disabled:b.disabled,confirming:b.dataset.confirming==='true'}))}})()`);
  const expect = async (check, message) => {
    const value = await card();
    if (!check(value)) throw new Error(`${message}: ${JSON.stringify(value)}`);
    reports.push(message);
  };
  const waitFor = async (check, message, timeout = 4_000) => {
    for (const started = Date.now(); Date.now() - started < timeout; await pause(50))
      if (check(await card())) break;
    await expect(check, message);
  };
  const press = (text) => click(button(text));
  const find = (value, text) => value.buttons.find((b) => b.text === text);
  fixture.win.destroy();
  open({ width: 806, height: 600 });
  await load("&view=server");
  // An update is pending and every bot is idle: Update is offered, nothing to stop.
  await waitFor((v) => v.state === "ready", "pending update with idle bots is ready");
  await expect((v) => v.text.includes("Server 0.0.10") && v.text.includes("Update to 0.0.11"), "older compatible server offers the installed desktop release without update-feed data");
  await assert(`document.body.innerText.includes('Desktop app 0.0.11') && document.querySelector('[data-settings-anchor="server-update"]')`, "Updates shows both desktop and server controls");
  await js(`document.querySelector('a[href="openteam://app/v1/settings?id=server-update"]').click()`);
  await assert(`fixture.links.at(-1)==='openteam://app/v1/settings?id=server-update' && fixture.updates.length===0`, "the compatibility notice links to server updates without starting one");
  await js(`fixture.desktop({latestVersion:'0.0.12',status:'available'})`);
  await expect((v) => v.state === "ready" && v.text.includes("Update to 0.0.11"), "a newer desktop feed must not update the server ahead of this desktop");
  await js(`fixture.desktop({latestVersion:null,status:'error',message:'Release feed unavailable'})`);
  await expect((v) => v.state === "ready", "a failed desktop update feed must not hide the server update");
  await js(`fixture.desktop({latestVersion:null,status:'up-to-date',message:null})`);
  await expect((v) => v.buttons.length === 1 && find(v, "Update")?.disabled === false, "only Update, enabled");
  await js(`fixture.server({currentVersion:"0.0.11"})`);
  await waitFor((v) => v.state === "up-to-date", "up to date");
  await expect((v) => v.text.includes("Your server matches desktop 0.0.11.") && v.buttons.length === 0, "matching-version banner, no buttons");
  await js(`fixture.server({currentVersion:"0.0.12"})`);
  await waitFor((v) => v.state === "up-to-date" && v.text.includes("newer than the installed desktop"), "newer servers are identified without offering a downgrade");
  await js(`fixture.server({currentVersion:"0.0.10"})`);
  await waitFor((v) => v.state === "ready", "pending again");

  // A bot starts working: the card names the first busy bot in sidebar order, Update waits.
  await js(`fixture.busy=[{botId:"b-chief",name:"Chief of Staff",runIds:["r1"]},{botId:"b-scout",name:"Scout",runIds:["r2"]}]`);
  await waitFor((v) => v.state === "busy", "busy after the next poll", 3_500);
  await expect((v) => v.text.includes(BUSY), "busy explanation names the busy bots in sidebar order");
  await expect((v) => v.buttons.map((b) => b.text).join("|") === "Stop Scout|Update", "Stop names Scout, the first busy bot in the sidebar");
  await expect((v) => find(v, "Update").disabled && !find(v, "Stop Scout").disabled, "Update disabled while busy");
  // The first click only arms the stop; the second stops that bot and holds while in flight.
  await js(`fixture.stopDelayMs=900`);
  await press("Stop Scout");
  await expect((v) => find(v, "Click Again to Confirm")?.confirming === true, "armed stop asks to confirm");
  await assert(`fixture.stops.length===0`, "an armed click stops nothing");
  await press("Click Again to Confirm");
  await expect((v) => find(v, "Stop Scout")?.disabled === true, "stopping holds the button");
  await waitFor((v) => v.buttons.map((b) => b.text).join("|") === "Stop Chief of Staff|Update", "next busy bot offered after the stop");
  await assert(`JSON.stringify(fixture.stops)==='["b-scout"]'`, "only the confirmed bot is stopped");
  await js(`fixture.stopDelayMs=0`);
  await press("Stop Chief of Staff");
  await press("Click Again to Confirm");
  await waitFor((v) => v.state === "ready" && v.buttons.length === 1, "idle once every bot is stopped");

  // A bot started working after the check: the CLI's refusal names it and shows as it is.
  await js(`fixture.failUpdate=${JSON.stringify(REFUSAL)}`);
  await press("Update");
  await expect((v) => find(v, "Click Again to Confirm")?.confirming === true, "Update asks to confirm");
  await press("Click Again to Confirm");
  await waitFor((v) => v.text.includes(REFUSAL), "busy refusal shown");
  await expect((v) => !v.text.includes("The server update failed"), "refusal isn't called a failure");

  // Update re-checks for work first, then updates every service together.
  await js(`fixture.failUpdate=null; fixture.server({status:"ready",message:null})`);
  const checks = await js(`fixture.busyChecks`);
  await press("Update");
  await press("Click Again to Confirm");
  await waitFor((v) => v.state === "updating" && v.buttons.length === 0, "Updating…");
  await expect((v) => v.text.includes("Pulling OpenTeam 0.0.11 container images"), "progress message");
  await assert(`fixture.busyChecks > ${checks}`, "Update re-checks for busy bots");
  await assert(`JSON.stringify(fixture.updates)==='[{"targetVersion":"0.0.11"},{"targetVersion":"0.0.11"}]'`, "both update requests target the desktop release");
  await expect((v) => v.text.includes("Step 2 of 5") && v.text.includes("Downloading update"), "download milestone comes from the host phase");
  await js(`fixture.server({phase:'future-phase',message:'Working on the update…'})`);
  await waitFor((v) => v.text.includes("Live progress") && !v.text.includes("Step 2"), "unknown phases do not invent progress");
  await js(`fixture.server({phase:'rolling-back',message:'Restoring the previous release…'})`);
  await waitFor((v) => v.text.includes("Recovering safely") && !v.text.includes("Step 5"), "rollback is presented as recovery, not successful progress");
  await js(`fixture.server({phase:'restarting',message:'Restarting services…'})`);
  await waitFor((v) => v.text.includes("Step 4 of 5"), "restart milestone");
  await assert(`fixture.destinations.every(url=>url==='https://openteam.example/api/v0/system/update') && fixture.payloads.every(body=>JSON.stringify(body)==='{"targetVersion":"0.0.11"}')`, "updates target only the selected server through its API");
  await js(`fixture.offline=true`);
  await pause(1800);
  await expect((v) => v.state === "updating", "maintenance restart preserves update progress");
  await expect((v) => v.text.includes("Reconnecting to the server…") && v.text.includes("Step 4 of 5"), "reconnect keeps the last reported milestone visible");
  await js(`fixture.offline=false;fixture.versionOffline=true;fixture.server({status:'updated',phase:'complete',currentVersion:'0.0.11'})`);
  await pause(1700);
  await expect((v) => v.state === "updating", "completion waits for the live version endpoint to reconnect");
  await js(`fixture.versionOffline=false;fixture.server({status:'updated',phase:'complete',currentVersion:'0.0.11'})`);
  await waitFor((v) => v.state === "up-to-date", "reconnect discovers the completed release");

  // Destroy the renderer and window, then reopen while the server is still offline.
  await js(`fixture.server({status:'updating',phase:'restarting',currentVersion:'0.0.10',jobId:'resumed-job',safeToCloseDesktop:true})`);
  await waitFor((v) => v.state === "updating" && v.text.includes("Step 4 of 5"), "active job is saved before closing");
  fixture.win.destroy();
  open({ width: 806, height: 700 });
  await load("&view=server&resume=offline");
  await waitFor((v) => v.state === "updating" && v.text.includes("Last seen: Restarting services"), "reopening offline restores last known progress");
  await expect((v) => v.text.includes("Reconnecting to the server…") && v.buttons.length === 0, "cached progress never starts a second update");
  await js(`fixture.offline=false;fixture.server({status:'updated',phase:'complete',currentVersion:'0.0.11'})`);
  await waitFor((v) => v.state === "up-to-date", "live completion replaces cached progress");
  await assert(`!localStorage.getItem('openteam:server-update:https://openteam.example') && fixture.updates.length===0`, "completion clears the cached active job without posting");
  await load("&view=server&resume=live");
  await waitFor((v) => v.state === "updating" && v.text.includes("Checking server health"), "reopening sees updates started by another client");
  await load("&view=server&resume=complete");
  await waitFor((v) => v.state === "up-to-date", "reopening after completion reads the running version");
  await js(`fixture.server({status:'unavailable',updaterAvailable:false,currentVersion:'0.0.10',message:'Run openteam start on the server to enable updates from the app.'})`);
  await waitFor((v) => v.state === "unavailable", "missing host updater shows recovery guidance");
  await expect((v) => v.text.includes("openteam start"), "recovery command names the server host");
  await load("&view=server&unknown");
  await waitFor((v) => v.state === "unavailable", "an unreported server version must not appear current");
  await expect((v) => v.text.includes("Server version unknown") && !v.text.includes("Your server matches") && find(v, "Update")?.disabled, "unknown server displays uncertainty and disables updates");
  return { reports };
};
