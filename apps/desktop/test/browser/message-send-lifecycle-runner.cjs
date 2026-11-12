const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.SEND_LIFECYCLE_DIR;
if (process.env.SEND_LIFECYCLE_REDUCED_MOTION === '1')
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
app.setPath('userData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({show: false, width: 1040, height: 760,
    webPreferences: {backgroundThrottling: false}});
  win.webContents.on('console-message', event => {
    if(event.message.startsWith('LIFECYCLE_STEP ')) console.log(event.message);
    if(event.message.startsWith('LIFECYCLE_RESULT ')) {
      fs.writeFileSync(path.join(directory, 'results.json'), event.message.slice('LIFECYCLE_RESULT '.length));
      app.quit();
    } else if(event.level === 'error') console.error(event.message);
  });
  await win.loadURL(process.env.SEND_LIFECYCLE_URL);
});
