import { Effect } from "../../apps/server/node_modules/effect";
import { AppService } from "../../apps/server/src/app-service";

const app = new AppService();
const action = process.argv[2] ?? "create";
try {
  await app.boss.start();
  const bot = await Effect.runPromise(app.createBot({
    clientRequestId: "vnc-qa-2026-09-12",
    name: "VNC QA Sep 12",
    description: "Disposable manual computer and shared-control QA bot.",
    instructions: "You are helping test the computer viewer. Only use /workspace/vnc-qa-0912 and the local QA page. Follow the user's QA instructions. Do not touch other work or create routines.",
    notificationsEnabled: false,
  }));
  console.log(JSON.stringify({ botId: bot.id, conversationId: bot.conversationId, dmChannelId: bot.dmChannelId, status: bot.status }));
  if (action === "status") {
    const screen = await Effect.runPromise(app.screenStatus(bot.id));
    console.log(JSON.stringify({ ...screen, viewerUrl: screen.viewerUrl.replace(/#.*$/, "#REDACTED") }));
  }
  if (action === "viewer-url") {
    const screen = await Effect.runPromise(app.screenStatus(bot.id));
    const url = new URL(screen.viewerUrl);
    url.hostname = "127.0.0.1";
    await Bun.write(Bun.stdout, `QA_VIEWER=${url.toString()}\n`);
  }
  if (action === "raw-screen" || action === "screen-action") {
    const screen = await Effect.runPromise(action === "raw-screen" ? app.screenStatus(bot.id) : app.screenAction(bot.id, JSON.parse(process.argv[3]!)));
    console.log(JSON.stringify(screen));
  }
  if (action === "takeover") {
    console.log(JSON.stringify(await Effect.runPromise(app.screenTakeover(bot.id,JSON.parse(process.argv[3]!)))));
  }
  if (action === "handoff") {
    const messages=await app.prisma.channelMessage.findMany({where:{channelId:bot.dmChannelId!},orderBy:{createdAt:"desc"},take:20});
    const message=messages.find(x=>(x.metadata as any)?.type==="computer-handoff");
    if(!message)throw new Error("No QA handoff yet");
    const command=process.argv[3]?JSON.parse(process.argv[3]):"info";
    const result=command==="info"?null:await Effect.runPromise(app.richMessages.mutateComputerHandoff(message.id,{action:command,clientId:"vnc-qa-handoff-"+command}));
    console.log(JSON.stringify({messageId:message.id,metadata:message.metadata,result}));
  }
  if (action === "frame") {
    const frame = await Effect.runPromise(app.screenFrame(bot.id));
    await Bun.write("/tmp/vnc-qa-frame.png",frame.bytes);
    console.log(JSON.stringify({path:"/tmp/vnc-qa-frame.png"}));
  }
  if (action === "message") {
    console.log(JSON.stringify(await Effect.runPromise(app.sendMessage(bot.conversationId, {
      clientId: process.argv[3]!, content: process.argv[4]!, timeZone: "America/New_York",
    }))));
  }
  if (action === "history") {
    console.log(JSON.stringify(await Effect.runPromise(app.channelHistory(bot.dmChannelId!, undefined, 30)), null, 2));
  }
  if (action === "runs") {
    console.log(JSON.stringify(await app.prisma.run.findMany({where:{botId:bot.id},orderBy:{createdAt:"desc"},take:5}),null,2));
    console.log(JSON.stringify(await Effect.runPromise(app.botTranscript(bot.id)),null,2));
    console.log(JSON.stringify(await app.prisma.runItem.findMany({where:{run:{botId:bot.id}},orderBy:{createdAt:"desc"},take:18}),null,2));
  }
  if (action === "control") {
    const screen = await Effect.runPromise(app.screenTakeover(bot.id, process.argv[3] === "true"));
    console.log(JSON.stringify({state:screen.state,humanTakeover:screen.humanTakeover,agentInputPaused:screen.agentInputPaused}));
  }
  if (action === "evidence") {
    const children = await app.prisma.subagent.findMany({where:{parentBotId:bot.id}});
    const runs = await app.prisma.run.findMany({where:{botId:{in:[bot.id,...children.map(x=>x.childBotId)]}},orderBy:{createdAt:"asc"}});
    const tools = await app.prisma.runItem.findMany({where:{runId:{in:runs.map(x=>x.id)},kind:{in:["tool","command"]}},orderBy:{createdAt:"asc"}});
    const evidence = {children,runs,tools:tools.filter(x=>x.title === "Computer" || x.title === "SendToUser").map(x=>({runId:x.runId,title:x.title,status:x.status,at:x.startedAt,content:x.content}))};
    await Bun.write("/tmp/vnc-qa-evidence.json",JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({children:children.map(x=>({id:x.id,status:x.status,result:x.result,error:x.error})),runs:runs.map(x=>({id:x.id,status:x.status,provider:x.inferenceProvider,model:x.inferenceModel})),toolCount:evidence.tools.length}));
  }
} finally {
  await Effect.runPromise(app.close());
}
