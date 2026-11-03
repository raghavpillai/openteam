const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", process.argv[4]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const phase = process.argv[3];
  const win = new BrowserWindow({show:false,width:806,height:700,webPreferences:{backgroundThrottling:false}});
  const js = code => win.webContents.executeJavaScript(code);
  await win.loadURL(process.argv[2] + '?resume=' + (phase === 'cleared' ? 'offline' : phase));
  const expected = phase === 'complete' ? 'up-to-date' : phase === 'cleared' ? 'unavailable' : 'updating';
  let view;
  for(let i=0;i<150;i++) {
    view = await js(`(()=>{const card=document.querySelector('[data-update-state]');return {state:card?.dataset.updateState,text:card?.innerText,posts:window.fixture?.updates.length}})()`);
    if(view.state===expected && (phase !== 'offline' || view.text.includes('Last seen: Checking server health'))) break;
    await delay(100);
  }
  if(view.state!==expected || view.posts!==0) throw new Error(phase + ': ' + JSON.stringify(view));
  if(phase==='offline' && (!view.text.includes('Last seen: Checking server health') || !view.text.includes('Step 5 of 5'))) throw new Error('The last known stage must survive a full app exit');
  if(phase==='complete' && !view.text.includes('Your server matches desktop 0.0.11.')) throw new Error('Live version must replace cached progress');
  if(phase==='cleared' && view.text.includes('Last seen:')) throw new Error('Completed jobs must not return as active after another cold launch');
  fs.writeFileSync(path.join(process.argv[5], 'cold-launch-' + phase + '.png'),(await win.webContents.capturePage()).toPNG());
  console.log(phase + ' cold launch passed');
  app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
