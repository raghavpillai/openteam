// Guards the reference wraps around Gmail tools: inline attachment integrity, search coverage
// and id-not-found notes. Texts are the reference's, verbatim.
import { emailBodyHtmlTag, unwrapHardWrappedEmailBody } from '@openteam/plugin-sdk/email-body';
import type { Args, Tool } from '../../_shared/google';

type Kind = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'other';
const KIND_LABELS: Record<Kind, string> = { pdf: 'PDF', png: 'PNG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP', other: 'attachment' };
const MIME_KINDS: Record<string, Kind> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };
const EXTENSION_KINDS: Record<string, Kind> = { pdf: 'pdf', png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' };
const END_SEARCH_WINDOW = 1024;
const DATA_URL_PREFIX = /^data:[^,]*;base64,/i;
const BASE64_BODY = /^[A-Za-z0-9+/]*$/;
type Attachment = { content: string; filename?: string; mimeType?: string };
export type AttachmentCheck = { attachment: Attachment; kind: Kind; check: 'valid' | 'undecodable' | 'pdf_no_header' | 'pdf_no_trailer' | 'image_mismatch' | 'image_incomplete'; bytes?: Buffer };

function kindOf(attachment: Attachment): Kind {
  const mime = attachment.mimeType?.split(';')[0]?.trim().toLowerCase();
  const byMime = mime === undefined ? undefined : MIME_KINDS[mime];
  if (byMime !== undefined) return byMime;
  const extension = attachment.filename?.trim().split('.').pop()?.toLowerCase();
  return (extension === undefined ? undefined : EXTENSION_KINDS[extension]) ?? 'other';
}
/** Base64 as models paste it: a data-URL prefix, whitespace, URL-safe characters and missing padding are fine. */
export function decodeAttachment(content: string): Buffer | undefined {
  const body = content.replace(DATA_URL_PREFIX, '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (body.length === 0 || body.length % 4 === 1 || !BASE64_BODY.test(body)) return undefined;
  return Buffer.from(body, 'base64');
}
const startsWith = (bytes: Buffer, prefix: string | number[], offset = 0) => {
  const expected = typeof prefix === 'string' ? Buffer.from(prefix, 'latin1') : Buffer.from(prefix);
  return bytes.subarray(offset, offset + expected.length).equals(expected);
};
function imageMatches(kind: Exclude<Kind, 'pdf' | 'other'>, bytes: Buffer) {
  switch (kind) {
    case 'png': return startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
    case 'jpeg': return startsWith(bytes, [255, 216, 255]);
    case 'gif': return startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a');
    case 'webp': return startsWith(bytes, 'RIFF') && startsWith(bytes, 'WEBP', 8);
  }
}
/** Whether an inline attachment decodes and, for PDFs and images, is complete and of the claimed type. */
export function checkGmailAttachment(attachment: Attachment): AttachmentCheck {
  const kind = kindOf(attachment);
  const bytes = decodeAttachment(attachment.content);
  const verdict = (check: AttachmentCheck['check']): AttachmentCheck => ({ attachment, kind, check, bytes });
  if (bytes === undefined) return verdict('undecodable');
  if (kind === 'pdf') {
    if (!bytes.subarray(0, END_SEARCH_WINDOW).includes('%PDF-', 0, 'latin1')) return verdict('pdf_no_header');
    if (!bytes.subarray(-END_SEARCH_WINDOW).includes('%%EOF', 0, 'latin1')) return verdict('pdf_no_trailer');
    return verdict('valid');
  }
  if (kind === 'other') return verdict('valid');
  if (!imageMatches(kind, bytes)) return verdict('image_mismatch');
  if (kind === 'png' && !bytes.subarray(-END_SEARCH_WINDOW).includes('IEND', 0, 'latin1')) return verdict('image_incomplete');
  return verdict('valid');
}
export const gmailAttachmentRefusal = (verdict: AttachmentCheck) =>
  `Not called: the attachment ${verdict.attachment.filename ?? '(no name)'} is incomplete or isn't a valid ${KIND_LABELS[verdict.kind]} file, so the email would arrive without it. Create the draft with no attachments, then attach the file with UploadFile using destination.draftId. Nothing was created or sent.`;
/** Refuses the call before anything is written when an attachment is broken. */
export function assertAttachmentsComplete(attachments: unknown) {
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment || typeof attachment !== 'object' || typeof attachment.content !== 'string') continue;
    const verdict = checkGmailAttachment({
      content: attachment.content,
      filename: typeof attachment.filename === 'string' && attachment.filename ? attachment.filename : undefined,
      mimeType: typeof attachment.mimeType === 'string' && attachment.mimeType ? attachment.mimeType : undefined,
    });
    if (verdict.check !== 'valid') throw new Error(gmailAttachmentRefusal(verdict));
  }
}

/** A plain-text body the model hard-wrapped, rejoined before the draft is built; HTML is left alone. */
export const unwrappedBody = (args: Args): Args =>
  typeof args.body === 'string' && emailBodyHtmlTag(args.body) === undefined
    ? { ...args, body: unwrapHardWrappedEmailBody(args.body) }
    : args;

const NARROWING_FILTER = /(?:^|[\s({-])(?:subject|label|category):|(?:^|[\s({])in:inbox(?=$|[\s)}])/i;
const ANYWHERE_SCOPE = /(?:^|[\s({])in:anywhere(?=$|[\s)}])/i;
const LOOKUP_OPERATOR = /(?:^|[\s({])(?:subject|from|to|cc|bcc|deliveredto|list|filename|rfc822msgid):/i;
const OPERATOR_TOKEN = /\w+:(?:"[^"]*"|\([^)]*\)|\{[^}]*\}|\S*)/g;
const BOOLEAN_WORD = /\b(?:OR|AND|AROUND)\b/g;
const FREE_TEXT = /[\p{L}\p{N}]/u;
export const GMAIL_SEARCH_EMPTY_NOTE = "Note: no thread matched this query, and one empty search does not show the message is missing. Before telling the user it is not in their mailbox, search every connected Gmail account again by the product, the seller and the sender's name or domain, one search each, with no subject:, label:, category: or in: filter, with includeTrash true and pageSize 50, and follow nextPageToken for one more page. If you still say it was not found, name only the searches you actually ran.";
export const GMAIL_SEARCH_MORE_PAGES_NOTE = "Note: more threads match this query than this page shows. If what the user asked for is not in this page, call search_threads again with this nextPageToken and pageSize 50, and search by the product, the seller and the sender with no subject:, label: or category: filter, before saying it is not in their mailbox.";
const isLookup = (query: string) =>
  LOOKUP_OPERATOR.test(query) || FREE_TEXT.test(query.replace(OPERATOR_TOKEN, ' ').replace(BOOLEAN_WORD, ' '));
/** The note a first search_threads page gets when it is empty and narrow, or when a lookup has more pages. */
export function searchCoverageNote(args: Args, page: { threads?: readonly unknown[]; nextPageToken?: string }): string | undefined {
  if (typeof args.pageToken === 'string' && args.pageToken.length > 0) return undefined;
  const query = typeof args.query === 'string' ? args.query : '';
  if (page.nextPageToken) return isLookup(query) ? GMAIL_SEARCH_MORE_PAGES_NOTE : undefined;
  if (page.threads?.length) return undefined;
  const widened = !NARROWING_FILTER.test(query) && (args.includeTrash === true || ANYWHERE_SCOPE.test(query));
  return widened ? undefined : GMAIL_SEARCH_EMPTY_NOTE;
}

const ID_FAILURE = /not found|could not be found|could not get (?:thread|message|draft)|invalid (?:\w+ )?id\b|AppErrorCode=5\b/i;
const LABEL_FAILURE = /\blabel\b/i;
export const GMAIL_ID_NOTES = {
  thread: "Note: Gmail found no thread with this threadId. This tool takes a thread id: the id of a thread in search_threads results. The id of a message in a thread's messages list is not a thread id, even though the two look alike. To act on one message, call the matching message tool with its messageId; to act on the whole thread, retry with the thread's id. Do not tell the user the email is missing until a call with the right id fails.",
  message: "Note: Gmail found no message with this messageId. This tool takes a message id: the id of one of a thread's messages from search_threads or get_thread, not a draft id. Read the thread with get_thread and retry with the message's id. Do not tell the user the email is missing until a call with the right id fails.",
  draft: "Note: Gmail found no draft with this draftId. Draft tools take a draft id, the id that create_draft and list_drafts return (it starts with r), not the draft's message id or thread id. A draft that was sent or deleted no longer exists. Call list_drafts and retry with the draft's current id. If the draft is not listed, tell the user it was already sent or deleted instead of guessing another id.",
} as const;
/** A failed id lookup names the kind of id the tool takes; the thread id and message id look alike. */
export const withIdNote = (kind: keyof typeof GMAIL_ID_NOTES, run: Tool['run']): Tool['run'] => async (args) => {
  try {
    return await run(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const id = args[`${kind}Id`];
    if (typeof id === 'string' && id.trim() && ID_FAILURE.test(message) && !LABEL_FAILURE.test(message))
      throw new Error(`${message}\n\n${GMAIL_ID_NOTES[kind]}`);
    throw error;
  }
};
