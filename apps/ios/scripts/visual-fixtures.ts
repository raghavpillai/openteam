/** Inert screen states transcribed from user-provided Grokbot captures; never run by a worker. */
export function visualFixture(base: any, scene: string) {
  const snapshot = structuredClone(base);
  const botTemplate = snapshot.bots[0], channelTemplate = snapshot.channels[0], runTemplate = snapshot.runs[0];
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
  if (scene === "inbox-reference") {
    const rows = [
      ["#00C875", "pod", "Are my replies showing up for you? If not, tell me what you see."],
      ["#FA2AA4", "pod", ""],
      ["#777777", "chip", "browserruncode capability check finished (one call, no retry)."],
      ["#9254FF", "classic", "Couldn’t finish the Google Flights lookup."],
      ["#9254FF", "owl", "Five upcoming public Luma events in New York."],
      ["#FF253C", "classic", "Benchmark 247 audit (from this turn’s tool receipts)."],
      ["#FF253C", "pod", "Blocked on desktop allocation — not on the task itself."],
      ["#946437", "pod", "Benchmark 246 audit (from this turn’s tool receipts)."],
      ["#00B8A9", "owl", "A long conversation title should leave room for the entire date."],
    ];
    rows.forEach(([color, icon, preview], i) => {
      const { channel } = bot(`inbox-${i}`, i === 8
        ? "A deliberately long conversation name that should truncate" : "New Bot", color!, icon!);
      const row = message(channel.id, i === 0 ? "user" : "agent", preview!, i + 1, i === 1 ? {
        type: "widget", widget: { prompt: "What should I draft for Jayne?",
          allowCustom: true, options: [
            { label: "Still on track", value: "on-track" },
            { label: "Delayed on customs", value: "delayed" },
            { label: "Not proceeding", value: "not-proceeding", style: "danger" },
            { label: "I’ll handle it", value: "handle" },
          ] },
      } : {});
      const stamp = new Date();
      if (i === 1) stamp.setDate(stamp.getDate() - 4);
      else if (i === 2) stamp.setMonth(10, 2);
      else if (i > 2) stamp.setMonth(8, 30);
      row.createdAt = stamp.toISOString();
      channel.updatedAt = row.createdAt;
      channel.unreadCount = i === 0 ? 1 : 0;
      if (i === 0) channel.notificationState.lastReadSequence = "0";
    });
    sidebar.channelOrderByGroup.unassigned = snapshot.channels.map((c: any) => c.id);
    snapshot.runs = [{ ...runTemplate, id: "inbox-background-run", botId: "bot-inbox-0",
      channelId: "inbox-0", status: "running" }];
  } else if (scene === "inbox-activity") {
    const previews = ["??", "", "Latest user message stays visible.",
      "Latest bot reply stays visible.", "Idle preview stays visible."];
    previews.forEach((preview, i) => {
      const { channel } = bot(`activity-${i}`, "New Bot", i === 1 ? "#FA2AA4" : "#00C875", "pod");
      const row = message(channel.id, i === 0 || i === 2 ? "user" : "agent", preview, i + 1,
        i === 1 ? { type: "widget", widget: { prompt: "What should I draft for Jayne?",
          options: [{ label: "Still on track", value: "on-track" }], allowCustom: true } } : {});
      channel.updatedAt = row.createdAt;
    });
    sidebar.channelOrderByGroup.unassigned = snapshot.channels.map((c: any) => c.id);
    snapshot.runs = [0, 1, 2, 3].map(i => ({ ...runTemplate, id: `activity-run-${i}`,
      botId: `bot-activity-${i}`, channelId: i === 0 ? null : `activity-${i}`, status: "running" }));
  } else if (scene === "inbox-unread") {
    // Widely separated unread targets exercise both directions and lazy offscreen rows.
    for (let i = 0; i < 44; i++) {
      const { channel } = bot(`unread-${i}`, `Conversation ${i + 1}`, "#00B8A9", "owl");
      const row = message(channel.id, "agent", `Inbox viewport fixture ${i + 1}`, i + 1);
      channel.updatedAt = row.createdAt;
      channel.unreadCount = [0, 14, 28, 43].includes(i) ? 3 : 0;
      if (channel.unreadCount) channel.notificationState.lastReadSequence = "0";
    }
    // A manually marked unread conversation must work too, with no server unread count.
    snapshot.channels.find((c: any) => c.id === "unread-14").unreadCount = 0;
    sidebar.unreadIds = ["unread-14"];
    sidebar.channelOrderByGroup.unassigned = snapshot.channels.map((c: any) => c.id);
  } else if (scene === "duo-sidebar") {
    const rows = [
      ["#FA2AA4", "pod", "What should I draft for you?"],
      ["#777777", "hex-visor", "Browser connection is ready."],
      ["#00C875", "pod", "Test"],
      ["#9254FF", "classic", "Couldn't finish the lookup."],
      ["#9254FF", "owl", "Five upcoming events."],
      ["#FF2545", "classic", "Browser navigation audit."],
      ["#A47952", "chip", "Ready when you are."],
      ["#1683FF", "terminal", "The weekly summary is ready."],
    ];
    rows.forEach(([color, icon, preview], index) => {
      const { channel } = bot(`duo-${index}`, "New Bot", color!, icon!);
      message(channel.id, "agent", preview!, index + 1).createdAt =
        new Date(date.getTime() - (index + 2) * 86400000).toISOString();
    });
    sidebar.channelOrderByGroup.unassigned = snapshot.channels.map((c: any) => c.id);
    sidebar.unreadIds = ["duo-6", "duo-7"];
  } else if (scene === "navigation-layout") {
    for (const [id, name] of [["visual-chat", "Main chat"], ["visual-other", "Other chat"]]) {
      const {channel} = bot(id!, name!, "#00B8A9", "owl");
      for (let i = 1; i <= 60; i++) message(channel.id, "agent",
        i === 60 ? `${name} latest` : i % 15 === 0
          ? `## ${name} details\n\n- First item\n- Second item\n- Third item`
          : `${name} message ${i}`, i);
    }
  } else if (scene === "group-avatars") {
    for (const count of [2, 3, 4, 5, 12]) {
      const id = `visual-group-${count}`;
      const group = {...channelTemplate, id, name: count === 5 ? "Hey" : `${count} bots`, kind:"group", members:[], hasAvatar:false};
      for (let index = 0; index < count; index++) {
        const memberId = `${id}-bot-${index}`;
        snapshot.bots.push({...botTemplate, id:memberId, name:`Member ${index + 1}`, dmChannelId:`dm-${memberId}`, color:["#0088FF","#00C875","#FA2AA4"][index % 3], icon:["pod","chip","terminal"][index % 3], hasAvatar:index === 0});
        group.members.push({botId:memberId,ordinal:index});
      }
      snapshot.channels.push(group);
      message(id,"agent","Group avatar reference.",snapshot.channelMessages.length+1).senderBotId = group.members[1].botId;
    }
    for (const [id, name] of [["visual-header-short", "Hi"], ["visual-header-long", "An intentionally long conversation title that must truncate safely"]]) {
      const {channel} = bot(id!, name!, "#00B8A9", "owl");
      message(channel.id, "agent", "Centered header reference.", snapshot.channelMessages.length + 1);
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
    if (isDark) { snapshot.bots[0].title=""; }
    // Around a draft card: another chat to switch to and, in the "-long" scenes, enough history
    // above the card to scroll its row out of the list and back.
    const draftSendSurroundings = (long: boolean) => {
      const other = bot("visual-other", "Other Bot", "#00B8A9", "cloud");
      message(other.channel.id, "user", "Anything new on the Friday order?", 1);
      message(other.channel.id, "agent", "Nothing yet — I'll tell you when it ships.", 2);
      sidebar.channelOrderByGroup.unassigned = [channel.id, other.channel.id];
      if (long) for (let i = 1; i <= 30; i++) message(channel.id, i % 2 ? "user" : "agent", `Earlier message ${i}. ${"Some context from before the draft. ".repeat(1 + i % 3)}`, i);
      // The card's rows follow at this offset.
      return long ? 30 : 0;
    };
    if (scene === "delivery-spacing") {
      message(channel.id, "agent", "Ready when you are.", 1);
      message(channel.id, "user", "Why is the return address Irving, Texas? That doesn't make sense.", 2);
      message(channel.id, "user", "Shouldn't it be going back to T-Mobile?", 3);
      message(channel.id, "agent", "Yes, it should go back to T-Mobile.", 4);
    } else if (isMotion) {
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
        ["user", 'Call UpdateMemory action forget with exact fact "MDEEP914S stable key is APRICOT-8136.". Return the exact tool result.'],
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
    if (scene === "initial-media-layout") {
      message(channel.id, "agent", "## Setup details\n\n" +
        "- A formatted message whose height arrives from WebKit.\n".repeat(8), 1);
      message(channel.id, "user", "Can you set this up?", 2, { attachments: [{
        assetId: "layout-portrait", fileName: "portrait.png", mimeType: "image/png",
        byteSize: 100, kind: "image", width: 400, height: 800,
      }] });
      message(channel.id, "agent", "## Next steps\n\n1. Review the settings.\n2. Save the changes.\n\n" +
        "| Task | Status |\n| --- | --- |\n| Layout | $x^2 + y^2$ |", 3);
      message(channel.id, "agent", "Layout settled marker", 4);
    } else if(scene === "scroll-mixed" || scene === "scroll-mixed-pages") {
      // Every row renderer in one transcript: native text/code, WebKit documents
      // and diagrams, fixed-size media, files, cards, replies and reactions.
      const image = (id:string, width?:number, height?:number) => ({ assetId:id, fileName:id+".png",
        mimeType:"image/png", byteSize:46000, kind:"image", ...(width ? { width, height } : {}) });
      const kinds: Array<(i:number) => ["user"|"agent", string, any?]> = [
        i => ["user", `Can you check item ${i}?`],
        i => ["agent", `Item ${i}. ${"Here is a plain native paragraph that wraps across several lines in the bubble. ".repeat(3)}`],
        i => ["agent", `## Summary ${i}\n\n- First finding about the deploy\n- Second finding with **bold** text\n- Third finding that is a little longer and wraps onto another line`],
        i => ["user", `Photo ${i}`, { attachments:[image("gallery-"+i, 545, 341)] }],
        i => ["agent", `Status ${i}\n\n| Service | State |\n| --- | --- |\n| API | Ready |\n| Worker | $x^2 + y^2$ |`],
        i => ["agent", `Code ${i}:\n\`\`\`swift\nlet value = items.map { $0.id }\nprint(value)\n\`\`\``],
        i => i % 3 === 0
          ? ["agent", `Diagram ${i}\n\n\`\`\`mermaid\nflowchart LR\n A[Draft] --> B[Review]\n B --> C[Done]\n\`\`\``]
          : ["agent", `Short reply ${i}.`],
        i => ["user", `Reply to ${i - 1}`, { replyTo:`visual-message-visual-chat-${i - 1}` }],
        i => ["agent", `Screenshot ${i}`, { attachments:[image("gallery-"+i)] }],
        i => ["agent", "", { type:"widget", widget:{ prompt:`Choose a route ${i}`, multiSelect:true, options:[
          { label:"Alpha", value:"alpha", description:"The first route" }, { label:"Beta", value:"beta" }, { label:"Gamma", value:"gamma" }] } }],
        i => ["agent", "", { attachment:{ assetId:"7".repeat(64), fileName:`archive-${i}.zip`, mimeType:"application/zip", byteSize:38000, kind:"file" } }],
        i => ["agent", `Reaction target ${i}`, { reactions:[{ emoji:"👍", by:"me" }, { emoji:"🎉", by:"bot-ops" }] }],
        i => ["agent", `# Report ${i}\n\nThe first paragraph explains the context in some detail so that the document is tall.\n\n> A quoted caveat that spans a couple of lines in the rendered document.\n\n1. Step one\n2. Step two\n3. Step three`],
        i => ["user", `Two photos ${i}`, { attachments:[image("layout-portrait", 400, 800), image("gallery-"+i, 545, 341)] }],
        i => ["agent", `Identifier ${i}: DEPLOYMENT_TOKEN_IDENTIFIER_${i}_ABCDEFGHIJKLMNOP was rotated.`],
        i => ["agent", "", { type:"widget", widget:{ prompt:`Pick one ${i}`, options:[{ label:"Alpha", value:"alpha" }, { label:"Beta", value:"beta" }] }, respondedValue:"alpha" }],
      ];
      const count = scene === "scroll-mixed-pages" ? 400 : 240;
      for (let i = 1; i <= count; i++) {
        const [sender, content, metadata] = kinds[i % kinds.length]!(i);
        const row = message(channel.id, sender, content, i, metadata ?? {});
        // Insert a timestamp row roughly every dozen messages.
        row.createdAt = new Date(date.getTime() - (count - i) * 1000 - Math.floor((count - i) / 12) * 600_000).toISOString();
      }
    } else if(scene === "background-activity") {
      message(channel.id, "user", "Can you check the shipping receipt?", 1);
      message(channel.id, "agent", "I’m checking the receipt. I’ll send you the tracking number when it’s ready.", 2);
    } else if(scene === "draft-send" || scene === "draft-send-long") {
      // A pending email reply; the fixture server answers its Send after ~900 ms.
      const at = draftSendSurroundings(scene.endsWith("-long"));
      message(channel.id, "user", "Tell Austin Monday at noon works and ask for the Teams invite.", at + 1);
      message(channel.id, "agent", "", at + 2, {type:"external-draft", cardState:"pending", draft:{platform:"email", from:"raghav@example.com", to:["austin@example.com"], cc:["colo-sales@example.com","noc@example.com"], subject:"RE: Month-to-month colocation inquiry — one server, 4kW", body:"Hi Austin,\n\nThanks! Monday, November 16 at 12:00pm EST works for me. Please send over the Teams invite.\n\nThanks,\nRaghav", replyToMessageId:"fixture-thread-message", verification:{identity:"raghav@example.com", sendingAddresses:["raghav@example.com"], thread:"RE: Month-to-month colocation inquiry — one server, 4kW"}}});
    } else if(scene === "imessage-send" || scene === "imessage-send-files" || scene === "imessage-send-long") {
      // A text waiting for approval with all three buttons, or files alone with Send and Discard on one row.
      // The fixture server answers Send after ~900 ms.
      const files = scene === "imessage-send-files";
      const at = draftSendSurroundings(scene.endsWith("-long"));
      message(channel.id, "user", files ? "Send Maya the two floor plans." : "Text Maya that I'm running ten minutes late.", at + 1);
      message(channel.id, "agent", "", at + 2, {type:"imessage-send", cardState:"pending", imessage:{text:files ? "" : "Running ten minutes late — grab a table and I'll find you!", to:"+1 (415) 555-0134", recipientName:"Maya Chen", recipientLabel:"Maya Chen", machineLabel:"Raghav's MacBook Pro", allowable:!files,
        ...(files ? {attachments:[{assetId:"1".repeat(64), fileName:"floor-plan-level-1.pdf", byteSize:412000}, {assetId:"2".repeat(64), fileName:"floor-plan-level-2.pdf", byteSize:388000}]} : {})}});
    } else if(scene === "empty-chat") {
      // No messages: initial positioning must still dismiss the native spinner.
    } else if(scene === "history-pages" || scene === "window-history") {
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
