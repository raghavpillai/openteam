import { createHash } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import type { ToolContext } from "@openteam/messaging";
import { metadataRecord, toJson } from "./service-utils";
const unavailable = (message: string): never => { throw new ApiError(409, "feedback_unavailable", message); };
export class FeedbackService {
  constructor(private readonly prisma: PrismaClient) {}
  async send(context: ToolContext, raw: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      process.env.OPENTEAM_FEEDBACK_ALLOW_AGENT !== "true" ||
      !process.env.OPENTEAM_FEEDBACK_URL
    )
      return unavailable(
        "Agent feedback is disabled by the deployment privacy settings or has no configured support destination. Nothing was sent."
      );
    const input = metadataRecord(raw);
    if (
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 4000 ||
      typeof input.wantsResponse !== "boolean"
    )
      return unavailable("Provide the user’s feedback and explicit wantsResponse preference");
    if (input.wantsResponse && !process.env.OPENTEAM_FEEDBACK_CONTACT)
      return unavailable(
        "A support reply address must be configured in the deployment before requesting a reply"
      );
    const destination = new URL(process.env.OPENTEAM_FEEDBACK_URL);
    if (
      destination.protocol !== "https:" &&
      destination.hostname !== "127.0.0.1" &&
      destination.hostname !== "localhost"
    )
      return unavailable("The feedback endpoint must use HTTPS");
    const scope = "feedback-send";
    const key = context.callId;
    const requestHash = createHash("sha256").update(JSON.stringify({
      botId: context.botId, message: input.message.trim(), wantsResponse: input.wantsResponse,
      endpoint: destination.href,
    })).digest("hex");
    const where = { scope_key: { scope, key } };
    const claim = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('feedback-rate-limit'))`;
      const prior = await tx.idempotencyRecord.findUnique({where});
      if (prior) {
        if (prior.requestHash !== requestHash) return unavailable("This feedback call ID belongs to different content");
        return {receipt: prior.status === "completed" ? metadataRecord(prior.response) : {
          feedbackStatus:"unknown",wantsResponse:input.wantsResponse,outcome:"This feedback has already started; check with support before retrying.",
        }};
      }
      const recent = await tx.idempotencyRecord.findFirst({where:{scope,createdAt:{gte:new Date(Date.now()-300_000)}}});
      if (recent) return {receipt:{feedbackStatus:"failed",wantsResponse:input.wantsResponse,outcome:"Feedback is rate limited. Try again after five minutes; nothing was sent."}};
      await tx.idempotencyRecord.create({data:{scope,key,requestHash,expiresAt:new Date(Date.now()+365*24*60*60_000)}});
      return {receipt:null};
    });
    if (claim.receipt) return claim.receipt;
    let feedbackStatus = "unknown";
    let outcome = "Feedback delivery was not confirmed. It will not be retried automatically.";
    try {
      signal?.throwIfAborted();
      const response = await fetch(destination.href, {
        method:"POST",headers:{"content-type":"application/json","idempotency-key":`feedback:${key}`,
          ...(process.env.OPENTEAM_FEEDBACK_TOKEN?{authorization:`Bearer ${process.env.OPENTEAM_FEEDBACK_TOKEN}`}:{})},
        body:JSON.stringify({id:key,product:"OpenTeam",message:input.message.trim(),wantsResponse:input.wantsResponse,
          ...(input.wantsResponse?{replyTo:process.env.OPENTEAM_FEEDBACK_CONTACT}:{})}),
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000),redirect:"error",
      });
      if(response.ok){feedbackStatus="sent";outcome="The configured OpenTeam support destination accepted the feedback.";}
      else if(response.status===429){feedbackStatus="failed";outcome="Support rate limited this feedback. Nothing will be retried automatically.";}
    } catch {}
    const receipt = {feedbackStatus,wantsResponse:input.wantsResponse,outcome};
    await this.prisma.idempotencyRecord.update({where,data:{status:"completed",response:toJson(receipt)}});
    signal?.throwIfAborted();
    return receipt;
  }
}
