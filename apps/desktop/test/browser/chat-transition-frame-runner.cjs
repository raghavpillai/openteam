
const {app,BrowserWindow}=require("electron");
const fs=require("node:fs"),path=require("node:path");
const dir=process.env.FRAME_CHECK_DIR;
app.setPath("userData",path.join(dir,"profile"));
fs.mkdirSync(path.join(dir,"frames"),{recursive:true});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:920,height:740,webPreferences:{offscreen:true,backgroundThrottling:false}});
 win.webContents.setFrameRate(60);
 const captures=[];
 win.webContents.on("paint",(_event,_rect,image)=>{
  if(captures.length>=2500)return;
  const filename=String(captures.length).padStart(5,"0")+".png";
  fs.writeFileSync(path.join(dir,"frames",filename),image.toPNG());
  captures.push({filename,time:Date.now()});
 });
 win.webContents.on("console-message",async(event)=>{
  if(event.message.startsWith("FRAME_CHECK_INPUT ")){
   const {text}=JSON.parse(event.message.slice("FRAME_CHECK_INPUT ".length));
   try{
    const selector='[data-prompt-editor] [contenteditable="true"], [data-prompt-editor] textarea, textarea';
    const focused=await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.focus();return true})()`);
    if(!focused)throw new Error("Native composer editor not found");
    win.webContents.insertText(text);
    await new Promise(resolve=>setTimeout(resolve,80));
    win.webContents.sendInputEvent({type:"keyDown",keyCode:"Return"});
    win.webContents.sendInputEvent({type:"keyUp",keyCode:"Return"});
    await win.webContents.executeJavaScript("window.__inputDone?.()");
   }catch(error){fs.writeFileSync(path.join(dir,"input-error.txt"),String(error));app.exit(1)}
  }else if(event.message.startsWith("FRAME_CHECK_RESULT ")){
   fs.writeFileSync(path.join(dir,"results.json"),event.message.slice("FRAME_CHECK_RESULT ".length));
   fs.writeFileSync(path.join(dir,"captures.json"),JSON.stringify(captures));
   app.quit();
  }else if(event.level==="error")console.error(event.message);
 });
 await win.loadURL(process.env.FRAME_CHECK_URL);
});
