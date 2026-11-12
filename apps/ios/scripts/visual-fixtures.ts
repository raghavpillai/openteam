/** Inert history fixture for paging and notification-opening tests; never run by a worker. */
export function visualFixture(base: any, scene: string) {
  const snapshot = structuredClone(base);
  const botTemplate = snapshot.bots[0], channelTemplate = snapshot.channels[0];
  snapshot.bots=[]; snapshot.channels=[]; snapshot.channelMessages=[]; snapshot.runs=[];
  const sidebar = { version:2, pinnedIds:[], unreadIds:[] as string[], unassignedCollapsed:false, sections:[] as any[], sectionByChannel:{}, channelOrderByGroup:{} as Record<string,string[]> };
  const date=new Date(); date.setHours(22,45,0,0);
  function bot(id:string,name:string,color:string,icon:string,description="") {
    const b={...botTemplate,id:"bot-"+id,name,title:name,color,icon:({hexagon:"chip",tablet:"terminal",cloud:"owl",triangle:"classic"} as Record<string,string>)[icon]??icon,description,hasAvatar:false,conversationId:"conversation-"+id,dmChannelId:id};
    const c={...channelTemplate,id,name,description,kind:"bot_dm",directKey:b.id,members:[{botId:b.id,ordinal:0}],unreadCount:0,notificationState:{lastReadSequence:"999",lastReadNotificationSequence:"0",notificationCursor:"0",notifications:[],activityUnreadCount:0}};
    snapshot.bots.push(b); snapshot.channels.push(c); return {bot:b,channel:c};
  }
  function message(channel:string,sender:"user"|"agent",content:string,index:number,metadata:any={}) {
    const row={id:`visual-message-${channel}-${index}`,clientId:null,sequence:String(index),channelId:channel,sender,senderBotId:sender==="agent"?"bot-"+channel:null,sourceRunId:null,content,metadata:{type:"text",...metadata},createdAt:new Date(date.getTime()+index*1000).toISOString()};
    snapshot.channelMessages.push(row); return row;
  }
  if (scene !== "history-pages") throw new Error(`Unknown visual scene: ${scene}`);
  const {channel}=bot("visual-chat","New Bot","#FF6600","hexagon");
  for (let i = 1; i <= 180; i++) message(channel.id, i % 2 ? "user" : "agent", `Page message ${i}`, i);
  return {snapshot,sidebar};
}
