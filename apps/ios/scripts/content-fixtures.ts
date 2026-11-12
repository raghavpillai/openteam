import type {ClientSnapshot} from '../../../packages/contracts/src/index';
/** Replaces the Research chat with one message for the named scene. */
export function contentScene(snapshot: ClientSnapshot, scene:string) {
  snapshot.runs=[];
  const message:any={id:'content-fixture',sequence:'400',channelId:'channel-research',sender:'bot',senderBotId:'bot-research',sourceRunId:null,content:'',metadata:{},createdAt:'2026-09-16T12:00:00.000Z'};
  if(scene==='attachment')message.metadata={attachments:[{assetId:'private-fixture-image',fileName:'Fixture image.png',mimeType:'image/png',byteSize:6000,kind:'image'}]};
  snapshot.channelMessages=snapshot.channelMessages.filter(m=>m.channelId!=='channel-research');snapshot.channelMessages.push(message);return snapshot;
}
