import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseAutomationEvent, type AutomationEvent } from "@openteam/messaging";
import { ApiError } from "@openteam/contracts";

export interface AutomationWebhookBinding {
  id: string;
  source: "slack" | "github" | "webhook" | "linear" | "sentry" | "pagerduty" | "microsoftTeams";
  owner: { kind: "bot" | "group"; id: string };
  secretEnv?: string;
  tenantId?: string;
  organizationId?: string;
  serviceId?: string;
  subscriptionId?: string;
  resource?: string;
  teamId?: string;
  repository?: string;
  selfUserId?: string;
  channelNames?: Record<string, string>;
}
const reject = (status: number, message: string): never => {
  throw new ApiError(status, "automation_webhook", message);
};
const same = (left: string, right: string) => {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const record = (raw: unknown): Record<string, any> =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
/** Bindings are operator-owned. A payload can never select its recipient bot. */
export async function automationWebhookBinding(
  id: string
): Promise<AutomationWebhookBinding | undefined> {
  const path = process.env.OPENTEAM_AUTOMATION_WEBHOOKS_FILE;
  if (!path) return undefined;
  const contents = await readFile(path, "utf8");
  if (contents.length > 200_000) return reject(500, "Webhook configuration is too large");
  const raw = JSON.parse(contents);
  if (!Array.isArray(raw) || raw.length > 100) return reject(500, "Invalid webhook configuration");
  const binding = raw.find((item) => item?.id === id) as AutomationWebhookBinding | undefined;
  if (!binding) return undefined;
  if (
    !["slack", "github", "webhook"].includes(binding.source) ||
    !["bot", "group"].includes(binding.owner?.kind) ||
    !/^[a-f0-9-]{36}$/i.test(binding.owner.id) ||
    !/^OPENTEAM_EVENT_[A-Z0-9_]+$/.test(binding.secretEnv ?? "") ||
    (binding.source === "slack" && !binding.teamId) ||
    (binding.source === "github" && !binding.repository)
  )
    return reject(500, "Invalid webhook binding");
  return binding;
}
async function boundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 1_000_000) {
        await reader.cancel();
        return reject(413, "Webhook payload is too large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
/** Verify raw-body signatures before reading provider fields. */
export async function receiveAutomationWebhook(
  request: Request,
  binding: AutomationWebhookBinding,
  secret: string,
  dispatch: (owner: AutomationWebhookBinding["owner"], event: AutomationEvent) => Promise<unknown>,
  now = Date.now(),
  fetchTeamsMessage?: (resource: string) => Promise<Record<string, any>>
): Promise<Response> {
  if (!secret || secret.length < 16) return reject(503, "Webhook signing secret is not configured");
  const validation=new URL(request.url).searchParams.get("validationToken");
  if(binding.source==="microsoftTeams"&&validation!==null) {
    if(validation.length>4096)return reject(400,"Invalid validation token");
    return new Response(validation,{headers:{"content-type":"text/plain","x-content-type-options":"nosniff"}});
  }
  const raw = await boundedBody(request);
  if (binding.source === "slack") {
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
    if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300)
      return reject(401, "Expired webhook signature");
    const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
    if (!same(expected, request.headers.get("x-slack-signature") ?? ""))
      return reject(401, "Invalid webhook signature");
  } else if (["linear","sentry","pagerduty"].includes(binding.source)) {
    const digest=createHmac("sha256",secret).update(raw).digest("hex");
    const header=request.headers.get(binding.source==="linear"?"linear-signature":binding.source==="sentry"?"sentry-hook-signature":"x-pagerduty-signature")??"";
    const valid=binding.source==="pagerduty"?header.split(",").some(part=>same(`v1=${digest}`,part.trim())):same(digest,header);
    if(!valid)return reject(401,"Invalid webhook signature");
  } else if(binding.source!=="microsoftTeams") {
    const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    if (
      !same(
        expected,
        request.headers.get(
          binding.source === "github" ? "x-hub-signature-256" : "x-openteam-signature-256"
        ) ?? ""
      )
    )
      return reject(401, "Invalid webhook signature");
  }
  let payload: Record<string, any>;
  try {
    payload = record(JSON.parse(raw));
  } catch {
    return reject(400, "Webhook payload must be JSON");
  }
  if(binding.source==="linear" && (!Number.isFinite(payload.webhookTimestamp)||Math.abs(now-payload.webhookTimestamp)>60_000))return reject(401,"Expired Linear webhook");
  if(binding.source==="microsoftTeams") {
    if(!Array.isArray(payload.value)||payload.value.length>1000)return reject(400,"Invalid Graph notifications");
    const events:AutomationEvent[]=[];
    for(const item of payload.value) {
      if(!same(secret,String(item.clientState??"")) || item.subscriptionId!==binding.subscriptionId || item.tenantId!==binding.tenantId)return reject(401,"Invalid Graph subscription notification");
      if(!binding.resource||typeof item.resource!=="string"||!item.resource.startsWith(binding.resource+"/"))return reject(403,"Graph resource does not match binding");
      const id=item.resource.slice(binding.resource.length+1);
      if(!/^[A-Za-z0-9_-]+$/.test(id))return reject(403,"Invalid Graph message resource");
      if(!fetchTeamsMessage)return reject(503,"Graph message reader is not configured");
      if(item.changeType==="deleted")continue;
      const message=await fetchTeamsMessage(item.resource);
      events.push(parseAutomationEvent({id:`${item.subscriptionId}:${id}:${message.lastModifiedDateTime??message.createdDateTime}`,source:"microsoftTeams",kind:"message",text:String(message.body?.content??"").slice(0,32000),tenantId:binding.tenantId,teamId:binding.teamId,channelId:message.channelIdentity?.channelId,actor:message.from?.user?.id,authenticatedUser:Boolean(message.from?.user?.id),occurredAt:message.createdDateTime}));
    }
    for(const event of events)await dispatch(binding.owner,event);
    return Response.json({accepted:true,events:events.length});
  }
  // The digest is signed with the body; unsigned delivery headers cannot create
  // multiple logical events from one captured webhook.
  payload.__deliveryDigest=createHash("sha256").update(raw).digest("hex");
  if (binding.source === "slack" && payload.type === "url_verification") {
    if (typeof payload.challenge !== "string" || payload.challenge.length > 1000)
      return reject(400, "Invalid URL challenge");
    return Response.json({ challenge: payload.challenge });
  }
  const events = normalizeWebhook(binding, payload, request.headers);
  for (const event of events) await dispatch(binding.owner, event);
  return Response.json({ accepted: true, events: events.length });
}
export function normalizeWebhook(
  binding: AutomationWebhookBinding,
  payload: Record<string, any>,
  headers: Headers
): AutomationEvent[] {
  if (binding.source === "webhook")
    return [parseAutomationEvent({ ...payload, source: "webhook" })];
  if (binding.source === "slack") {
    if (payload.team_id !== binding.teamId)
      return reject(403, "Slack workspace does not match the binding");
    const event = record(payload.event);
    const channel = event.channel ?? event.item?.channel;
    if (
      typeof channel !== "string" ||
      !["message", "app_mention", "reaction_added"].includes(event.type) ||
      event.hidden ||
      ["message_deleted", "message_changed"].includes(event.subtype)
    )
      return [];
    const timestamp = Number(event.event_ts ?? event.ts);
    return [
      parseAutomationEvent({
        id: payload.event_id,
        source: "slack",
        kind: event.type === "reaction_added" ? "reaction" : "message",
        channel: binding.channelNames?.[channel] ?? channel,
        channelId: channel,
        text: String(event.text ?? "").slice(0, 32_000),
        mention:
          event.type === "app_mention" ||
          Boolean(
            binding.selfUserId && String(event.text ?? "").includes(`<@${binding.selfUserId}>`)
          ),
        emoji: event.reaction,
        actor: event.user,
        bySelf: Boolean(binding.selfUserId && event.user === binding.selfUserId),
        ...(Number.isFinite(timestamp) && timestamp > 0
          ? { occurredAt: new Date(timestamp * 1000).toISOString() }
          : {}),
      }),
    ];
  }
  if(binding.source==="linear") {
    if(binding.organizationId&&payload.organizationId!==binding.organizationId)return reject(403,"Linear organization does not match binding");
    const data=record(payload.data);if(binding.teamId&&String(data.teamId??data.team?.id)!==binding.teamId)return [];
    const kind=payload.type==="Issue"&&payload.action==="create"?"issueCreated":payload.type==="Issue"&&payload.action==="update"&&"stateId" in record(payload.updatedFrom)?"statusChanged":payload.type==="Cycle"&&payload.action==="update"&&data.completedAt&&!payload.updatedFrom?.completedAt?"endOfCycle":null;
    if(!kind)return [];
    return [parseAutomationEvent({id:payload.__deliveryDigest,source:"linear",kind,text:JSON.stringify(data).slice(0,32000),projectId:data.projectId,teamId:data.teamId,statusId:data.stateId,...(payload.type==="Cycle"?{cycleId:data.id}:{cycleId:data.cycleId}),actor:payload.actor?.id,occurredAt:payload.createdAt})];
  }
  if(binding.source==="sentry") {
    const issue=record(payload.data?.issue);const organization=payload.installation?.organization?.id??payload.organization?.id;
    if(binding.organizationId&&String(organization)!==binding.organizationId)return reject(403,"Sentry organization does not match binding");
    if(headers.get("sentry-hook-resource")!=="issue")return [];
    const kind=({created:"issueCreated",resolved:"issueResolved",assigned:"issueAssigned",ignored:"issueArchived",archived:"issueArchived",unresolved:"issueUnresolved"} as Record<string,string>)[payload.action];
    if(!kind)return [];
    return [parseAutomationEvent({id:payload.__deliveryDigest,source:"sentry",kind,text:JSON.stringify(issue).slice(0,32000),projectId:String(issue.project?.id??issue.project),actor:payload.actor?.id?String(payload.actor.id):undefined})];
  }
  if(binding.source==="pagerduty") {
    const event=record(payload.event);const data=record(event.data);const serviceId=String(data.service?.id??"");
    if(binding.serviceId&&binding.serviceId!==serviceId)return [];
    const kind=({"incident.triggered":"incidentTriggered","incident.acknowledged":"incidentAcknowledged","incident.resolved":"incidentResolved","incident.escalated":"incidentEscalated"} as Record<string,string>)[event.event_type];
    if(!kind)return [];
    return [parseAutomationEvent({id:event.id??payload.__deliveryDigest,source:"pagerduty",kind,text:JSON.stringify(data).slice(0,32000),serviceId,occurredAt:event.occurred_at,actor:event.agent?.id})];
  }
  if (String(payload.repository?.full_name).toLowerCase() !== binding.repository?.toLowerCase())
    return reject(403, "GitHub repository does not match the binding");
  const type = headers.get("x-github-event");
  let kind: string | undefined;
  const action = payload.action;
  if (type === "pull_request")
    kind = (
      {
        opened: "pr-opened",
        synchronize: "pr-pushed",
        closed: payload.pull_request?.merged ? "pr-merged" : "pr-closed",
        review_requested: "review-requested",
      } as Record<string, string>
    )[action];
  if (type === "pull_request_review" && action === "submitted")
    kind = (
      {
        approved: "review-approved",
        changes_requested: "review-changes-requested",
        commented: "review-commented",
      } as Record<string, string>
    )[payload.review?.state];
  if (type === "pull_request_review_comment" && action === "created")
    kind = "inline-review-comment";
  if (type === "pull_request_review_thread")
    kind = (
      { resolved: "review-thread-resolved", unresolved: "review-thread-unresolved" } as Record<
        string,
        string
      >
    )[action];
  if (type === "issue_comment" && action === "created" && payload.issue?.pull_request)
    kind = "pr-comment";
  if (type === "issues" && action === "assigned") kind = "issue-assigned";
  const check = record(payload.check_suite ?? payload.check_run ?? payload.workflow_run);
  if (["check_suite", "check_run", "workflow_run"].includes(type ?? "") && action === "completed")
    kind =
      check.conclusion === "success"
        ? "ci-passed"
        : ["failure", "timed_out", "action_required", "startup_failure"].includes(check.conclusion)
          ? "ci-failed"
          : undefined;
  if (!kind) return [];
  const prs = payload.pull_request?.number
    ? [payload.pull_request.number]
    : payload.issue?.pull_request
      ? [payload.issue.number]
      : Array.isArray(check.pull_requests) && check.pull_requests.length
        ? check.pull_requests.map((pr: any) => pr.number)
        : [undefined];
  return prs.map((pr: unknown) =>
    parseAutomationEvent({
      id: headers.get("x-github-delivery"),
      source: "github",
      kind,
      text: JSON.stringify(payload).slice(0, 32_000),
      repo: binding.repository,
      pr,
      actor: payload.sender?.login,
      branch: check.head_branch ?? payload.pull_request?.head?.ref,
    })
  );
}
