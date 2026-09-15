// @ts-nocheck
// Generated from the September 12 tool source: schema construction and pure normalization only.
import { z as external_exports } from "zod";
import * as import_node_path165 from "node:path";
const import_node_path166 = import_node_path165;
class SandToolInputError extends Error {}
const MESSAGES_PAGE_LIMITS = {
  items: { default: 50, max: 200 },
  search: { default: 25, max: 100 },
  "find-chats": { default: 50, max: 500 }
};
const MESSAGES_SERVICES = ["iMessage", "SMS", "auto"];
function limitParameter(limits) {
  return external_exports.number().int().min(1).optional().describe(
    `Max results to return; the newest are kept. Defaults to ${limits.default}; the Mac clamps to ${limits.max}.`
  );
}
const beforeParameter = external_exports.object({ date: external_exports.string(), id: external_exports.number().int() }).optional().describe(
  "Copy a truncated result's `nextBefore` (`{date, id}`) verbatim to get the next-older page."
);
const findContactsParameters = external_exports.object({
  query: external_exports.string().trim().min(1).describe("A person's name or the start of one; matches any name part, case-insensitively.")
});
const findChatsParameters = external_exports.object({
  displayName: external_exports.string().trim().min(1).optional().describe(
    "Match a group chat by its exact title, not a substring. One-to-one chats have no title, so this never finds a person; get the handle from FindContacts."
  ),
  handle: external_exports.string().trim().min(1).optional().describe(
    "Match a chat whose participant handle equals this exactly, as Messages stores it: an E.164 number (`+15555550100`) or an email."
  ),
  limit: limitParameter(MESSAGES_PAGE_LIMITS["find-chats"])
});
const chatItemsParameters = external_exports.object({
  chatGuid: external_exports.string().trim().min(1).optional().describe(
    "The chat's guid, from FindIMessageChats (e.g. `iMessage;-;+15555550100`). Omitting it reads the whole history, keeps only the newest page, and truncates; prefer a guid, SearchIMessages, or IMessageActivity."
  ),
  limit: limitParameter(MESSAGES_PAGE_LIMITS.items),
  before: beforeParameter
});
const searchParameters = external_exports.object({
  query: external_exports.string().trim().min(1).describe("Text to look for in message bodies."),
  limit: limitParameter(MESSAGES_PAGE_LIMITS.search),
  before: beforeParameter
});
const activityParameters = external_exports.object({
  since: external_exports.string().trim().min(1).describe("Start of the window (inclusive), an ISO-8601 timestamp with offset."),
  until: external_exports.string().trim().min(1).optional().describe(
    "End of the window (exclusive), an ISO-8601 timestamp with offset. Omit to run up to now."
  )
});
const fetchAttachmentParameters = external_exports.object({
  messageGuid: external_exports.string().trim().min(1).describe("The guid of the message carrying the attachment."),
  attachmentGuid: external_exports.string().trim().min(1).describe("The attachment's guid, from the message's `attachments` list.")
});
const sendParameters = external_exports.object({
  text: external_exports.string().min(1).describe("The message body, sent verbatim."),
  to: external_exports.string().trim().min(1).optional().describe(
    "One recipient's handle, exactly an E.164 number (`+15555550100`) or an email; a name or a national-format number is rejected before anything is sent. Get a number from FindContacts. Reaches a one-to-one chat only. Use this or `chatId`."
  ),
  chatId: external_exports.string().trim().min(1).optional().describe(
    "The chat's `guid` from FindIMessageChats (`iMessage;+;chat\u2026` for a group), not its `identifier`. The only way to reach a group chat. Use this or `to`."
  ),
  service: external_exports.enum(MESSAGES_SERVICES).optional().describe(
    "`iMessage` or `SMS` to force one. Omit (or `auto`) to try iMessage, then SMS only if the address is not on iMessage. Ignored with `chatId`, whose guid already carries the service."
  ),
  recipientName: external_exports.string().optional().describe(
    "The recipient's name exactly as FindContacts returned it, shown to the user on the approval card beside the number. Only used with `to`; a `chatId` send shows the chat guid alone. Omit when you do not have one."
  )
});
const checkPermissionsParameters = external_exports.object({});
const listCredentialsParameters = external_exports.object({
  site: external_exports.string().trim().optional().describe(
    "Current website URL or domain. Always pass this when a browser login is blocked; only credentials allowed for that live site are returned."
  ),
  query: external_exports.string().trim().optional().describe(
    "Optional service/name search when no website URL is available, e.g. reform or stripe."
  )
});
const credentialProviderStatusParameters = external_exports.object({}).strict();
const COOKIE_ORIGIN_APPROVAL_MAX_ORIGINS = 32;
const requestCookieOriginApprovalParameters = external_exports.object({
  origins: external_exports.array(
    external_exports.union([
      external_exports.string(),
      external_exports.object({
        origin: external_exports.string().describe("Chrome cookie host, e.g. example.com."),
        profileId: external_exports.string().describe(
          'Chrome profile directory id exactly as listed, e.g. "Default" or "Profile 2". Never the user-visible display name: "Work" or "Person 1" are display names, not profile ids.'
        )
      })
    ])
  ).max(COOKIE_ORIGIN_APPROVAL_MAX_ORIGINS).optional().describe(
    "Chrome cookie hosts to request. Omit or pass [] to list available profile and origin pairs. A bare host asks across every profile that has it; pass { origin, profileId } to ask for one profile only. Pass one or more entries to open the approval dialog and wait."
  )
});
const uploadFileParameters = external_exports.object({
  connection: external_exports.string().trim().min(1).describe(
    "Which connected service receives the file, by connection name. The description lists every connection available this turn."
  ),
  sourcePath: external_exports.string().trim().min(1).describe(
    "Absolute path of the file on your computer, e.g. the path a Shell command or CopyToBox produced. Only files under /workspace or your own agent directory (/home/box/agent-data/agents/<your id>) can be sent; directories are not accepted."
  ),
  destination: external_exports.object({
    path: external_exports.string().trim().optional().describe(
      'Folder path inside the destination service, e.g. "Reports/2026". Omit to use the service root.'
    ),
    folderId: external_exports.string().trim().optional().describe(
      "Provider folder id, when you already have one from that connection's listing tools. Provide at most one of path or folderId."
    ),
    draftId: external_exports.string().trim().optional().describe(
      "Email connections only: the id of an existing draft, as returned by that connection's create_draft, to attach the file to. Not combined with path or folderId."
    ),
    name: external_exports.string().trim().optional().describe("File name at the destination. Defaults to the source file's name."),
    overwrite: external_exports.boolean().optional().describe(
      "OneDrive only: replace a file that already exists at the destination. Default false: an existing file makes the upload fail so you can pick another name."
    )
  }).default({}).describe(
    "Where the file lands. Which fields apply depends on the connection; see the description."
  )
});
const downloadFileParameters = external_exports.object({
  connection: external_exports.string().trim().min(1).describe(
    "Which connected service holds the file, by connection name. The description lists every connection available this turn."
  ),
  source: external_exports.object({
    fileId: external_exports.string().trim().optional().describe(
      "Provider file id from that connection's listing or search tools. Google Drive takes ids only."
    ),
    path: external_exports.string().trim().optional().describe(
      'OneDrive only: file path from the OneDrive root, e.g. "Documents/notes.txt". Provide exactly one of fileId or path.'
    )
  }).describe("Which file to pull. Provide exactly one of fileId or path."),
  destination: external_exports.object({
    path: external_exports.string().trim().optional().describe(
      "Absolute path on your computer for the file, name included; only paths under /workspace or your own agent directory (/home/box/agent-data/agents/<your id>) are accepted. Omit to land it in your downloads folder under the service's file name; the result tells you where. An existing file at the path is replaced."
    )
  }).default({}).describe("Where the file lands on your computer.")
});
function nonEmpty2(value) {
  return value === void 0 || value.length === 0 ? void 0 : value;
}
function nonEmpty3(value) {
  return value === void 0 || value.length === 0 ? void 0 : value;
}
const UPLOAD_FILE_MAX_NAME_LENGTH = 255;
function normalizeSource(source) {
  const fileId = nonEmpty2(source.fileId);
  const path31 = nonEmpty2(source.path);
  if (fileId !== void 0 && path31 !== void 0) {
    throw new SandToolInputError(
      "source.fileId and source.path are alternatives; pass exactly one."
    );
  }
  if (fileId !== void 0) return { fileId };
  if (path31 === void 0) {
    throw new SandToolInputError("source needs fileId or path; pass exactly one.");
  }
  return { path: path31 };
}
function normalizeDestination(destination) {
  const path31 = nonEmpty3(destination.path);
  const folderId = nonEmpty3(destination.folderId);
  const draftId = nonEmpty3(destination.draftId);
  const targetsGiven = [path31, folderId, draftId].filter((value) => value !== void 0).length;
  if (targetsGiven > 1) {
    throw new SandToolInputError(
      "destination.path, destination.folderId and destination.draftId are alternatives; pass one or none."
    );
  }
  if (destination.name !== void 0) {
    if (destination.name.length === 0 || destination.name.length > UPLOAD_FILE_MAX_NAME_LENGTH) {
      throw new SandToolInputError(
        `destination.name must be between 1 and ${UPLOAD_FILE_MAX_NAME_LENGTH} characters.`
      );
    }
    if (destination.name.includes("/") || destination.name.includes("\\") || destination.name.includes("\0")) {
      throw new SandToolInputError(
        "destination.name is a file name only; put folders in destination.path."
      );
    }
  }
  return {
    ...path31 === void 0 ? {} : { path: path31 },
    ...folderId === void 0 ? {} : { folderId },
    ...draftId === void 0 ? {} : { draftId },
    ...destination.name === void 0 ? {} : { name: destination.name },
    ...destination.overwrite === void 0 ? {} : { overwrite: destination.overwrite }
  };
}
function normalizeSourcePath(raw) {
  if (raw.includes("\0")) {
    throw new SandToolInputError("sourcePath contains an invalid character.");
  }
  if (!import_node_path166.posix.isAbsolute(raw)) {
    throw new SandToolInputError(
      `sourcePath ${JSON.stringify(raw)} is not absolute. Pass the full path on your computer, e.g. "/home/box/agent-data/agents/<id>/attachments/report.pdf".`
    );
  }
  const normalized = import_node_path166.posix.normalize(raw);
  if (normalized.endsWith("/")) {
    throw new SandToolInputError("sourcePath must name a file, not a directory.");
  }
  return normalized;
}
function normalizeDestinationPath(raw) {
  const path31 = nonEmpty2(raw);
  if (path31 === void 0) return void 0;
  if (!import_node_path165.posix.isAbsolute(path31)) {
    throw new SandToolInputError(
      `destination.path ${JSON.stringify(path31)} is not absolute. Pass the full path on your computer, e.g. "/home/box/agent-data/agents/<id>/downloads/report.pdf", or omit it.`
    );
  }
  const normalized = import_node_path165.posix.normalize(path31);
  if (normalized.endsWith("/")) {
    throw new SandToolInputError(
      "destination.path must name a file (folder plus file name), not a directory."
    );
  }
  return normalized;
}
const schemas = { FindContacts:findContactsParameters, FindIMessageChats:findChatsParameters, ChatItems:chatItemsParameters, SearchIMessages:searchParameters, IMessageActivity:activityParameters, FetchIMessageAttachment:fetchAttachmentParameters, SendIMessage:sendParameters, CheckIMessagePermissions:checkPermissionsParameters, ListCredentials:listCredentialsParameters, GetCredentialProviderStatus:credentialProviderStatusParameters, request_cookie_origin_approval:requestCookieOriginApprovalParameters, upload_file:uploadFileParameters, download_file:downloadFileParameters };
export function parseReferenceArguments(name: string, raw: unknown): Record<string, any> {
 const schema = schemas[name]; if(!schema) throw new Error('No reference parser: '+name);
 const args = schema.parse(raw);
 if(name==='upload_file')return {...args,sourcePath:normalizeSourcePath(args.sourcePath),destination:normalizeDestination(args.destination)};
 if(name==='download_file')return {...args,source:normalizeSource(args.source),destination:{...args.destination,path:normalizeDestinationPath(args.destination.path)}};
 return args;
}
