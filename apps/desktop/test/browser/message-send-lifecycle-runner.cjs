const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.SEND_LIFECYCLE_DIR;
if (process.env.SEND_LIFECYCLE_REDUCED_MOTION === '1')
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
app.setPath('userData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({show: process.env.SEND_LIFECYCLE_RECORD === '1', width: 1040, height: 760,
    webPreferences: {backgroundThrottling: false}});
  const frames = [];
  const steps = [];
  if(process.env.SEND_LIFECYCLE_RECORD === '1') {
    fs.mkdirSync(path.join(directory, 'frames'), {recursive: true});
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', (_event, method, params) => {
      if(method !== 'Page.screencastFrame') return;
      const name = `frame-${String(frames.length).padStart(5, '0')}.jpg`;
      fs.writeFileSync(path.join(directory, 'frames', name), Buffer.from(params.data, 'base64'));
      frames.push({name, time: params.metadata.timestamp});
      void win.webContents.debugger.sendCommand('Page.screencastFrameAck', {sessionId: params.sessionId});
    });

  }
  win.webContents.on('console-message', event => {
    if(event.message.startsWith('LIFECYCLE_STEP ')) {
      console.log(event.message);
      steps.push({name: event.message, time: Date.now() / 1000});
      if(process.env.SEND_LIFECYCLE_RECORD === '1') {
        const name = event.message.slice('LIFECYCLE_STEP '.length).replace(/[^a-z0-9-]/g, '-');
        void win.webContents.capturePage().then(image => fs.writeFileSync(path.join(directory, `${name}.png`), image.toPNG()));
      }
    }
    if(event.message.startsWith('LIFECYCLE_RESULT ')) {
      fs.writeFileSync(path.join(directory, 'results.json'), event.message.slice('LIFECYCLE_RESULT '.length));
      if(frames.length) {
        void win.webContents.debugger.sendCommand('Page.stopScreencast');
        fs.writeFileSync(path.join(directory, 'frames', 'frames.json'), JSON.stringify(frames));
      }
      fs.writeFileSync(path.join(directory, 'steps.json'), JSON.stringify(steps));
      app.quit();
    } else if(event.level === 'error') console.error(event.message);
  });
  await win.loadURL(process.env.SEND_LIFECYCLE_URL);
  if(process.env.SEND_LIFECYCLE_RECORD === '1')
    await win.webContents.debugger.sendCommand('Page.startScreencast', {format: 'jpeg', quality: 88, everyNthFrame: 1});
});
