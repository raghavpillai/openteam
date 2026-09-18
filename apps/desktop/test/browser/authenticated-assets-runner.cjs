const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.ASSET_TEST_OUTPUT, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.session.on("will-download", (event) => event.preventDefault());
  win.webContents.on("console-message", (_event, _level, message) => console.error(message));
  try {
    await win.loadURL(process.env.ASSET_TEST_URL);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      async function until(fn,stage) { for(let i=0;i<250;i++){ if(fn())return;await wait(20); } throw Error('Asset UI timed out: '+stage+' '+document.body.textContent.slice(0,300)); }
      await until(()=>[...document.querySelectorAll('[data-private-image]')].filter(i=>i.naturalWidth>0&&i.src.startsWith('blob:')).length===2,'images');
      await until(()=>{const image=document.querySelector('img[alt="Private Markdown photo"]');return image?.naturalWidth>0&&image.src.startsWith('blob:');},'Markdown image');
      document.querySelector('[aria-label="Open private.md"]').click();
      await until(()=>document.body.textContent.includes('Authenticated file content'),'markdown');
      let download;
      const click=HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click=function(){download=this.href;};
      document.querySelector('[aria-label="Download file"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      await until(()=>download?.startsWith('blob:'),'download');
      const text=await(await fetch(download)).text();
      if(!text.includes('Authenticated file content'))throw Error('Wrong download content');
      HTMLAnchorElement.prototype.click=click;
      return {privateImages:3,markdownPreview:true,blobDownload:true};
    })()`);
    fs.writeFileSync(
      path.join(process.env.ASSET_TEST_OUTPUT, "results.json"),
      JSON.stringify(result, null, 2)
    );
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  }
});
