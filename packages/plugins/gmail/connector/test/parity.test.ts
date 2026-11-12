import { expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { gmailTools } from '../server';
import { harness } from '../../../test/parity-harness';

const source = { id: 'message-1', threadId: 'thread-1', labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [
  { name: 'Message-ID', value: '<original@example.com>' }, { name: 'References', value: '<ancestor@example.com>' },
  { name: 'From', value: 'Sender <sender@example.com>' }, { name: 'Reply-To', value: 'reply@example.com' },
  { name: 'Subject', value: 'A résumé' }, { name: 'Date', value: 'Sat, 12 Sep 2026 09:00:00 -0400' },
], body: { data: Buffer.from('Original message 🌎').toString('base64url') } } };

test('Gmail builds a real multipart HTML reply with thread headers, Unicode and byte-exact attachments', async () => {
  const attachment = Buffer.from([0, 255, 1, 13, 10, 240]);
  const chart = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('IHDR....IDAT....IEND', 'latin1')]);
  const h = harness(gmailTools, [source, { id: 'draft-1', message: { id: 'new-message', threadId: 'thread-1' } }]);
  const result = await h.call('create_draft', { replyToMessageId: 'message-1', body: 'My reply', htmlBody: '<b>My reply</b><img src="cid:chart.png">',
    attachments: [{ filename: 'chart.png', mimeType: 'image/png', content: chart.toString('base64'), inline: true }, { filename: 'résumé.bin', content: attachment.toString('base64') }] });
  const request = h.requests[1]!.json;
  const parsed = await PostalMime.parse(Buffer.from(request.message.raw, 'base64url'));
  expect(request.message.threadId).toBe('thread-1');
  expect(result.id).toBe('draft-1');
  expect(parsed.subject).toBe('Re: A résumé');
  expect(parsed.to?.[0]?.address).toBe('reply@example.com');
  expect(parsed.inReplyTo).toBe('<original@example.com>');
  expect(parsed.references).toContain('<ancestor@example.com>');
  expect(parsed.text).toContain('Original message 🌎');
  expect(parsed.html).toContain('<b>My reply</b>');
  expect(parsed.attachments).toHaveLength(2);
  expect(parsed.attachments[0]!.contentId).toBe('<chart.png>');
  expect(parsed.attachments[1]!.filename).toBe('résumé.bin');
  expect(Buffer.from(parsed.attachments[1]!.content as ArrayBuffer)).toEqual(attachment);
});

test('Gmail supports empty/HTML-only drafts and rejects injected headers before a write', async () => {
  const h = harness(gmailTools, [{ id: 'draft' }]);
  await h.call('create_draft', { htmlBody: '<p>Only HTML ✓</p>' });
  const parsed = await PostalMime.parse(Buffer.from(h.requests[0]!.json.message.raw,'base64url'));
  expect(parsed.html).toContain('Only HTML ✓');
  await expect(h.call('create_draft', { to: ['a@example.com\r\nBcc: other@example.com'] })).rejects.toThrow('newlines');
  await expect(h.call('create_draft', { attachments: [{ filename: 'x', content: 'invalid!' }] })).rejects.toThrow("Not called: the attachment x is incomplete or isn't a valid attachment file");
  // The second request is the one-time account lookup for the draft's link.
  expect(h.requests.map((request) => request.url.pathname)).toEqual(['/drafts', '/profile']);
});

// Shaped like Google's hosted results (2026-10 captures): Gmail web links name the account and the decimal
// form of the hex thread and message ids; search shows a thread's newest 5 messages beside its full count.
const threadId = '19a2b3c4d5e6f701';
const mail = (n: number, extra: Record<string, unknown> = {}) => ({ id: n === 1 ? threadId : `19a2b3c4d5e6f7${String(n).padStart(2, '0')}`, threadId, labelIds: ['INBOX'], snippet: `Note ${n}`, historyId: '7001', internalDate: String(1791900000000 + n), sizeEstimate: 1000 + n,
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Ann <ann@example.com>' }, { name: 'To', value: 'me@example.com' }, { name: 'Subject', value: 'Plans' }, { name: 'Date', value: `Tue, 13 Oct 2026 0${n}:00:00 +0000` }], body: { data: Buffer.from(`Body ${n}`).toString('base64url') } }, ...extra });
const link = (id?: string) => `https://mail.google.com/mail/?authuser=me@example.com#all/thread-f:${BigInt(`0x${threadId}`)}${id ? `|msg-f:${BigInt(`0x${id}`)}` : ''}`;
