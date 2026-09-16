import { DynamicToolCallRequest } from "@openteam/contracts";
import { Schema, Effect } from "effect";
import { spoolFile, type StagedFile } from "@openteam/plugin-sdk/file-spool";
import type { InternalToolService } from "./services/internal-tool-service";

export async function connectorTransferResponse(request: Request, tools: InternalToolService) {
  const header=request.headers.get("x-openteam-transfer") ?? "";
  if(header.length>32_768)throw new Error("Transfer metadata exceeds the header limit");
  const call=Schema.decodeUnknownSync(DynamicToolCallRequest)(JSON.parse(Buffer.from(header,"base64url").toString()));
  if(call.tool!=="ExecuteConnectorTransfer")throw new Error("Invalid transfer operation");
  const args=call.arguments as Record<string,any>;
  let upload:StagedFile|undefined;
  try {
    if(args.tool==="upload_file") {
      if(!Number.isSafeInteger(args.sizeBytes)||args.sizeBytes<0||!/^[a-f0-9]{64}$/.test(args.sha256))throw new Error("Invalid upload staging envelope");
      upload=await spoolFile(request.body ?? new ReadableStream({start(c){c.close();}}),{signal:request.signal,sizeBytes:args.sizeBytes,sha256:args.sha256});
    }
    const result=await Effect.runPromise(tools.execute(call,{upload,stream:true}),{signal:request.signal}) as Record<string,any>;
    if(!result.file)return Response.json(result);
    const {file,...metadata}=result as {file:StagedFile;[key:string]:any};
    const reader=Bun.file(file.path).stream().getReader();
    const body=new ReadableStream<Uint8Array>({
      async pull(controller){try{const next=await reader.read();if(next.done){controller.close();await file.cleanup();}else controller.enqueue(next.value);}catch(error){controller.error(error);await file.cleanup();}},
      async cancel(){await reader.cancel();await file.cleanup();},
    });
    return new Response(body,{headers:{"content-type":"application/octet-stream","content-length":String(file.sizeBytes),"x-openteam-transfer-result":Buffer.from(JSON.stringify(metadata)).toString("base64url")}});
  } finally {await upload?.cleanup();}
}

/** Other routes keep the previous request-size bound, including chunked bodies. */
export function boundedRequest(request:Request,limit:number):Request {
  if(!request.body)return request;
  let size=0;
  const stream=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){size+=chunk.length;if(size>limit)throw new Error("Request body exceeds size limit");controller.enqueue(chunk);}}));
  return new Request(request,{body:stream,duplex:"half"} as RequestInit);
}
