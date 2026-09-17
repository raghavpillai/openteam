import { referenceTool } from "./tool-contracts";
export { DESKTOP_MESSAGES_TOOLS } from "./desktop-capability-names";
const string = { type: "string", minLength: 1 };
const limit = {
  type: "integer",
  minimum: 1,
  description: "Maximum newest results; defaults to 50, capped at 200.",
};
const before = {
  type: "object",
  properties: { date: string, id: { type: "integer" } },
  required: ["date", "id"],
  additionalProperties: false,
};
const definition = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});
export const DESKTOP_CAPABILITY_TOOLS = [
  definition(
    "FindContacts",
    "Find people in the connected Mac's Contacts by name. Returns names, email addresses and phone numbers. Requires Contacts access.",
    { query: string },
    ["query"]
  ),
  definition(
    "FindIMessageChats",
    "Find chats by exact group displayName or participant handle. Use FindContacts to resolve people. One-to-one chats usually have no display name.",
    { displayName: string, handle: string, limit }
  ),
  definition(
    "ChatItems",
    "Read newest messages, replies, reactions, edits and attachment metadata. Prefer a chatGuid; pass nextBefore verbatim to page older items.",
    { chatGuid: string, limit, before }
  ),
  definition(
    "SearchIMessages",
    "Search message bodies in the connected Mac's Messages history. Returns newest matches and nextBefore for paging.",
    { query: string, limit, before },
    ["query"]
  ),
  definition(
    "IMessageActivity",
    "Summarize activity by chat within an ISO-8601 time window: since inclusive, until exclusive.",
    { since: string, until: string },
    ["since"]
  ),
  definition(
    "FetchIMessageAttachment",
    "Fetch an attachment from a verified message. Images are shown inline; other files are saved in the box. Limit 100 MiB; unavailable iCloud files are reported.",
    { messageGuid: string, attachmentGuid: string },
    ["messageGuid", "attachmentGuid"]
  ),
  definition(
    "SendIMessage",
    "Send the exact text after user review. Specify exactly one of a verified chatId GUID or recipient to (E.164 number/email). recipientName is display metadata only. Never retry an uncertain send.",
    {
      text: string,
      to: string,
      chatId: string,
      service: { enum: ["auto", "iMessage", "SMS"] },
      recipientName: string,
    },
    ["text"]
  ),
  definition(
    "CheckIMessagePermissions",
    "Check Mac Messages Full Disk Access and Automation permissions without sending a message.",
    {}
  ),
  definition(
    "ListCredentials",
    "Search configured 1Password login metadata, never values. At a login pass the current site URL. To use a matching item, SendToUser type credential-request with credential {kind:browser-login, credential_id, connection_id, catalog_revision, site, purpose}. Approval binds to a live browser page; values remain private.",
    { site: string, query: string }
  ),
  definition(
    "GetCredentialProviderStatus",
    "Report saved-login provider connection health and setup guidance; no secret values are returned.",
    {}
  ),
  definition(
    "request_cookie_origin_approval",
    "Omit origins to list available Chrome profile/origin pairs. Pass listed hosts or {origin,profileId} to approve import into the bot browser. Grants are scoped to that bot, profile and host and can be revoked in Computer settings.",
    {
      origins: {
        type: "array",
        maxItems: 32,
        items: {
          anyOf: [
            string,
            {
              type: "object",
              properties: { origin: string, profileId: string },
              required: ["origin", "profileId"],
              additionalProperties: false,
            },
          ],
        },
      },
    }
  ),
].map(tool => referenceTool(tool.name));
