import { convert } from 'html-to-text';
import { base64Bytes, compact } from '../../_shared/reference';
import type { Args } from '../../_shared/google';

export const plainHtml = (html: string) => convert(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] });
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function decodeHeader(value = ''): string {
  return value.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset, encoding, body) => {
    try {
      const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(body, 'base64') : Buffer.from(body.replaceAll('_', ' ').replace(/=([0-9a-f]{2})/gi, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
      return new TextDecoder(charset).decode(bytes);
    } catch { return body; }
  });
}
export const headersOf = (message: any): Record<string, string> => Object.fromEntries((message.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), decodeHeader(h.value)]));
const recipients = (value = '') => value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(v => v.match(/<([^>]+)>/)?.[1] ?? v.trim()).filter(Boolean);
export function normalizeMessage(message: any, format = 'FULL_CONTENT'): any {
  if (format === 'MESSAGE_FORMAT_UNSPECIFIED') format = 'FULL_CONTENT';
  const h = headersOf(message);
  const metadata = format === 'METADATA_ONLY';
  const full = format === 'FULL_CONTENT' || format === 'PLAIN_TEXT';
  const text: string[] = [], html: string[] = [], attachments: any[] = [];
  const visit = (part: any) => {
    if (part.filename || part.body?.attachmentId) {
      if (part.filename) attachments.push(compact({ id: part.body?.attachmentId, filename: part.filename, mimeType: part.mimeType }));
      if (part.filename) return;
    }
    if (part.body?.data) {
      const charset = part.headers?.find((x: any) => String(x.name).toLowerCase() === 'content-type')?.value?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? 'utf-8';
      let decoded: string;
      try { decoded = new TextDecoder(charset).decode(Buffer.from(part.body.data, 'base64url')); }
      catch { decoded = Buffer.from(part.body.data, 'base64url').toString('utf8'); }
      if (part.mimeType === 'text/plain') text.push(decoded);
      if (part.mimeType === 'text/html') html.push(decoded);
    }
    for (const child of part.parts ?? []) visit(child);
  };
  if (full) visit(message.payload ?? {});
  const time = h.date ? Date.parse(h.date) : Number(message.internalDate);
  return compact({
    id: message.id, threadId: message.threadId, labelIds: message.labelIds,
    historyId: message.historyId, internalDate: message.internalDate, sizeEstimate: message.sizeEstimate,
    sender: h.from, toRecipients: recipients(h.to), ccRecipients: recipients(h.cc), bccRecipients: recipients(h.bcc),
    date: Number.isFinite(time) ? new Date(time).toISOString() : undefined,
    subject: metadata ? undefined : h.subject, snippet: metadata ? undefined : message.snippet,
    plaintextBody: full ? (text.join('\n') || (html.length ? plainHtml(html.join('\n')) : '')) : undefined,
    htmlBody: format === 'FULL_CONTENT' && html.length ? html.join('\n') : undefined,
    attachments: full ? attachments : undefined,
    attachmentIds: full ? attachments.map(a => a.id).filter(Boolean) : undefined,
    raw: format === 'RAW' ? message.raw : undefined,
  });
}

const safeHeader = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw new Error('Email headers cannot contain newlines or NUL');
  return value;
};
const foldedBase64 = (bytes: Buffer) => bytes.toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
const textPart = (content: string, mime: string) => `Content-Type: ${mime}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldedBase64(Buffer.from(content))}`;
const multipart = (parts: string[], subtype: string) => {
  const boundary = `openteam-${crypto.randomUUID()}`;
  return `Content-Type: multipart/${subtype}; boundary="${boundary}"\r\n\r\n${parts.map(p => `--${boundary}\r\n${p}\r\n`).join('')}--${boundary}--`;
};
export function draftMime(args: Args, original?: any) {
  let body = args.body, html = args.htmlBody;
  const originalHeaders = original ? headersOf(original) : {};
  const subject = args.subject ?? (original ? (/^re:/i.test(originalHeaders.subject ?? '') ? originalHeaders.subject : `Re: ${originalHeaders.subject ?? ''}`) : '');
  const headers = ['MIME-Version: 1.0', `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`];
  const to = args.to ?? (original ? recipients(originalHeaders['reply-to'] ?? originalHeaders.from) : []);
  for (const [name, values] of Object.entries({ To: to, Cc: args.cc, Bcc: args.bcc })) {
    if (values?.length) headers.push(`${name}: ${values.map((v: string) => safeHeader(v)).join(', ')}`);
  }
  if (original) {
    const id = originalHeaders['message-id'];
    if (!id) throw new Error('The original message has no Message-ID; a correctly threaded reply cannot be created.');
    headers.push(`In-Reply-To: ${safeHeader(id)}`);
    headers.push(`References: ${safeHeader([originalHeaders.references, id].filter(Boolean).join(' '))}`);
    const normalized = normalizeMessage(original);
    const quote = `On ${originalHeaders.date ?? 'the previous message'}, ${originalHeaders.from ?? 'the sender'} wrote:`;
    if (body !== undefined || html === undefined) body = `${body ?? ''}\n\n${quote}\n${(normalized.plaintextBody ?? '').split('\n').map((line: string) => `> ${line}`).join('\n')}`;
    if (html !== undefined) html = `${html}<br><br>${escapeHtml(quote)}<blockquote>${normalized.htmlBody ?? escapeHtml(normalized.plaintextBody ?? '').replaceAll('\n', '<br>')}</blockquote>`;
  }
  const texts = [];
  if (body !== undefined || html === undefined) texts.push(textPart(body ?? '', 'text/plain'));
  if (html !== undefined) texts.push(textPart(html, 'text/html'));
  let content = texts.length > 1 ? multipart(texts, 'alternative') : texts[0]!;
  let size = 0;
  const inline: string[] = [], regular: string[] = [];
  for (const attachment of args.attachments ?? []) {
    const bytes = base64Bytes(attachment.content);
    size += bytes.length;
    if (size > 25 * 1024 * 1024) throw new Error('Combined attachments exceed 25 MB. Use a Drive link for larger files.');
    const name = safeHeader(attachment.filename ?? 'attachment');
    const mimeType = safeHeader(attachment.mimeType ?? 'application/octet-stream');
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new Error('Invalid attachment MIME type');
    const cid = name.replace(/[^A-Za-z0-9._@-]/g, '_');
    const lines = [`Content-Type: ${mimeType}`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${attachment.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'", '%27')}`,
      ...(attachment.inline ? [`Content-ID: <${cid}>`] : [])];
    (attachment.inline ? inline : regular).push(`${lines.join('\r\n')}\r\n\r\n${foldedBase64(bytes)}`);
  }
  if (inline.length) content = multipart([content, ...inline], 'related');
  if (regular.length) content = multipart([content, ...regular], 'mixed');
  return { raw: Buffer.from(`${headers.join('\r\n')}\r\n${content}`).toString('base64url'), threadId: original?.threadId ?? args.threadId };
}
