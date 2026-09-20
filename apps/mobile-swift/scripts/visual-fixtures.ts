/** Inert screen states transcribed from user-provided Grokbot captures; never run by a worker. */
export function visualFixture(base: any, scene: string) {
  const snapshot = structuredClone(base);
  const botTemplate = snapshot.bots[0], channelTemplate = snapshot.channels[0], runTemplate = snapshot.runs[0];
  snapshot.bots=[]; snapshot.channels=[]; snapshot.channelMessages=[]; snapshot.runs=[]; snapshot.approvals=[];
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
  if (scene === "group-avatars") {
    for (const count of [2, 3, 4, 5, 12]) {
      const id = `visual-group-${count}`;
      const group = {...channelTemplate, id, name: count === 5 ? "Hey" : `${count} bots`, kind:"group", members:[], hasAvatar:false};
      for (let index = 0; index < count; index++) {
        const memberId = `${id}-bot-${index}`;
        snapshot.bots.push({...botTemplate, id:memberId, name:`Member ${index + 1}`, dmChannelId:`dm-${memberId}`, color:["#0088FF","#00C875","#FA2AA4"][index % 3], icon:["pod","chip","terminal"][index % 3], hasAvatar:index === 0});
        group.members.push({botId:memberId,ordinal:index});
      }
      snapshot.channels.push(group);
      message(id,"agent","Group avatar reference.",snapshot.channelMessages.length+1);
    }
  } else if(scene==="home" || scene.startsWith("dark-home")) {
    date.setDate(date.getDate()-(scene.startsWith("dark-home") ? 2 : 1));
    const rows=[
      ["Memory Box 914","#00C875","hexagon","",""],
      ["Memory SSE 914 B","#FA2AA4","tablet","","Synthetic memory notification fixture."],
      ["Memory SSE 914 A","#FF9900","hexagon","","Synthetic memory notification fixture."],
      ["Memory Deep 914 Server","#FA2AA4","cloud",'No facts in your memory match "MDEEP914S"…',""],
      ["Memory Deep 914 Box","#00B8A9","cloud","CERULEAN781","Synthetic memory fixture. Follow test requests."],
      ["Memory Deep 914 Box copy","#00B8A9","cloud",'No facts in your memory match "LANTERN914"…',""],
      ["Memory Server Isolation 914","#1683FF","tablet","QUARTZ5719",""],
      ["Memory Scope 914 Primary","#9254FF","triangle","ACK","Synthetic memory notification fixture."],
      ["Memory Scope 914 Room A","#9254FF","triangle",'Top 1 match for "ORBIT914" in your memory…',"Synthetic memory notification fixture."],
      ["Memory Scope 914 Room B","#9254FF","triangle",'No facts in your memory match "ORBIT914V"…',""],
      ["Memory Server Room 914 A","#1683FF","tablet",'No facts in your memory match "ORBIT914V"…',""]
    ];
    if (scene.startsWith("dark-home")) rows.push(
      ["Memory Server Room 914 B", "#1683FF", "tablet", 'No facts in your memory match "ORBIT914V"…', ""],
      ["Memory Scope 914 Peer B", "#00B8A9", "triangle", "", ""],
      ["Memory Scope 914 Peer A", "#946437", "hexagon", "", ""],
      ["Visual history end", "#946437", "hexagon", "", ""]
    );
    rows.forEach(([name,color,icon,preview,description],i)=>{
      const {channel}=bot("visual-"+i,name!,color!,icon!,description!);
      message(channel.id,"agent",preview!,i+1,i===0?{attachments:[{assetId:"fixture-file",fileName:"Attachment",mimeType:"text/plain",byteSize:10,kind:"file"}]}:{});
      channel.unreadCount=i===6||i===10?1:0;
      if(i===8||i===9) {
        const partner={...botTemplate,id:"visual-room-partner-"+i,name:i===8?"Room A":"Room B",color:i===8?"#946437":"#00B8A9",icon:i===8?"hex-visor":"classic",hasAvatar:false,dmChannelId:""};
        snapshot.bots.push(partner);
        channel.kind="group";
        channel.members=[...channel.members,{botId:partner.id,ordinal:1}];
      }
    });
    sidebar.sections=[{id:"empty-section",name:"XDD",collapsed:!scene.startsWith("dark-home")}];
    sidebar.channelOrderByGroup.unassigned=snapshot.channels.map((c:any)=>c.id);
    if (scene.startsWith("dark-home")) {
      sidebar.channelOrderByGroup.unassigned = ["visual-3", ...sidebar.channelOrderByGroup.unassigned.filter(id=>id!=="visual-3")];
      const serverMessage = snapshot.channelMessages.find((m:any)=>m.channelId==="visual-3");
      serverMessage.content="Got it — here.";
      const today = new Date(); today.setHours(14,52,0,0); serverMessage.createdAt=today.toISOString();
    }
  } else {
    const isLong=scene==="long",isActions=scene==="actions",isDark=scene.startsWith("dark-");
    const isMotion = scene === "motion-reference";
    const name=isMotion?"Memory Deep 914 Box copy":isLong?"Compaction Ten 0913":isActions?"Memory Deep 914 Box":isDark?"Memory Deep 914 Server":"New Bot";
    const {channel}=bot("visual-chat",name,isDark?"#FA2AA4":isLong||isActions||isMotion?"#00B8A9":"#FF6600",isDark||isLong||isActions||isMotion?"cloud":"hexagon");
    if (isDark) { snapshot.bots[0].title=""; snapshot.bots[0].instructions=""; }
    if (isMotion) {
      // Inert text from the supplied recording, for matched animation captures.
      date.setDate(date.getDate()-1);
      const rows: ["user"|"agent",string][] = [
        ["user", "Without looking anything up or using tools except sending the reply, what was the puzzle nonce I gave earlier? If it is not in your context, return UNKNOWN. Do not guess."],
        ["agent", "UNKNOWN"],
        ["user", 'Call RecallMemory query "LANTERN914", scope agent, limit 50. Return the exact result. Do not read files or contact other bots.'],
        ["agent", "Looking up LANTERN914 in agent memory."],
        ["agent", 'No facts in your memory match "LANTERN914" (0 searched). Try different words, or a shorter literal fragment.'],
      ];
      rows.forEach(([sender,content],i)=>message(channel.id,sender,content,i+1));
    } else if (isDark) {
      const rows:["user"|"agent",string][]=[
        ["user", 'Call update_state target memory action forget with exact fact "MDEEP914S stable key is APRICOT-8136.". Return the exact tool result.'],
        ["agent", "Forgetting that memory now."],
        ["agent", "Forgot from your memory: MDEEP914S stable key is APRICOT-8136."],
        ["user", 'Call RecallMemory query "MDEEP914S", scope agent, limit 50. Return the exact result. Do not read files or contact other bots.'],
        ["agent", "Calling RecallMemory now."],
        ["agent", 'No facts in your memory match "MDEEP914S" (1 searched). Try different words, or a shorter literal fragment.'],
        ["user", "Hi"], ["agent", "Hey. What’s up?"], ["user", "Test"], ["agent", "Got it — here."]
      ];
      if (scene === "dark-chat-seven") rows.unshift(["agent", 'Top 1 match for "MDEEP914S" in your memory (2 facts searched):\n\n• (2026-09-14) [profile] MDEEP914S stable key is APRICOT-8136.']);
      date.setHours(14,40,0,0);
      rows.forEach(([sender,content],i)=>{ if(content==="Hi")date.setHours(14,52,0,0); message(channel.id,sender,content,i+1); });
    } else
    if(scene === "history-pages") {
      for (let i = 1; i <= 180; i++) message(channel.id, i % 2 ? "user" : "agent", `Page message ${i}`, i);
    } else if(scene === "performance-text" || scene === "performance-rich") {
      // Already-loaded histories, as after pagination or restoring the local cache.
      // Bounded, deterministic workloads shared by the before/after UI benchmark.
      const count = scene === "performance-text" ? 1000 : 200;
      for (let i = 1; i <= count; i++) {
        const content = scene === "performance-rich" && i % 10 === 0
          ? `History item ${i}.\n\n| Item | Status |\n| --- | --- |\n| Rendered table | Ready |\n| Formula | $x^2 + y^2$ |\n\n> A longer quoted message to exercise variable-height document layout.`
          : `History item ${i}.\n\nA multiline conversation with **emphasis** and \`inline code\`. ${"Keep the conversation responsive. ".repeat(1 + i % 4)}`;
        message(channel.id, i % 2 ? "user" : "agent", content, i);
      }
    } else if(scene==="history") {
      for(let i=1;i<=200;i++) message(channel.id,i%2?"user":"agent",`History item ${i}.\n\nA multiline conversation with **emphasis** and \`inline code\`. Keep the text responsive while scrolling, entering a draft, and returning home.`,i);
    } else if(isLong) {
      message(channel.id,"user",'Use RecallMemory twice, with scope agent and limit 50: query "MPAIR-914-A Zephyr" and query "MPAIR-914-A Helios". Report both raw tool resultThis is the disposable compaction test CEDAR-QUARTZ-913. Name this bot Compaction Ten 0913. We are planning a fictional release, not performing it. Project CEDAR-QUARTZ has owner Lena Ortiz. Initial port 6201 and region us-west-1 are provisional. Deployment requires reviewer approval. For each numbered update in this test, keep the current decisions in conversational context and acknowledge with ACK plus the update number. Do not write project notes or use retrieval during these ten updates. Update 1: acknowledge ACK1.ts verbatim, not what you recall from this chat. Do not write memory or read transcripts.',1);
      message(channel.id,"agent","Running both RecallMemory queries and renaming to Compaction Ten 0913.",2);
      message(channel.id,"agent","",3,{type:"event",event:{type:"name-changed",from:"New Bot",to:name}});
      message(channel.id,"agent",["Zephyr","Helios"].map(term=>`**RecallMemory** \`scope=agent limit=50\` query "MPAIR-914-A ${term}" (raw):\nNo facts in your memory match\n"MPAIR-914-A ${term}" (0 searched). Try different words, or a shorter literal fragment.`).join("\n\n"),4);
      message(channel.id,"agent","ACK1\n\nCurrent decisions remain in this conversation. Project CEDAR-QUARTZ owner Lena Ortiz.",5);
    } else if(isActions) {
      const nonce="Without looking anything up or using tools except sending the reply, what was the puzzle nonce I gave earlier? If it is not in your context, return UNKNOWN. Do not guess.";
      const rows:["user"|"agent",string][]=[
        ["agent",'No facts in your memory match "LANTERN914" (0 searched). Try different words, or a shorter literal fragment.'],["user",nonce],["agent","CERULEAN781"],
        ["user","For this synthetic checkpoint, answer the arithmetic question 7 plus 5. Return only the number, with no explicit memory tool calls."],["agent","12"],
        ["user","For this synthetic checkpoint, answer the arithmetic question 8 plus 6. Return only the number, with no explicit memory tool calls."],["agent","14"],["user",nonce],["agent","CERULEAN781"]
      ]; rows.forEach(([sender,content],i)=>message(channel.id,sender,content,i+1));
    } else {
      message(channel.id,"user","Testing 133 message",1);
      if(scene!=="keyboard") { message(channel.id,"agent","Got it — test message received.",2); channel.unreadCount=1;channel.notificationState.lastReadSequence="1"; }
      if(scene==="thinking") message(channel.id,"user","Testttt",3);
      if(scene==="thinking"||scene==="keyboard") snapshot.runs=[{...runTemplate,id:"visual-run",botId:"bot-visual-chat",channelId:channel.id,status:"running"}];
    }
  }
  return {snapshot,sidebar};
}
