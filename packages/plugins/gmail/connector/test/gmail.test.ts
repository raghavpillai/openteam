import { expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { harness } from '../../../test/parity-harness';
import { gmailTools } from '../server';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

// Attachment verdicts match the reference implementation (10-20 build).
test('create_draft refuses a truncated, mistyped or cut attachment before anything is written', async () => {
  const h = harness(gmailTools, []);
  for (const [attachment, label] of [
    [{ filename: 'invoice.pdf', mimeType: 'application/pdf', content: pdf.subarray(0, 20).toString('base64') }, 'invoice.pdf is incomplete or isn\'t a valid PDF file'],
    [{ filename: 'report.pdf', content: Buffer.from('hello world').toString('base64') }, 'report.pdf is incomplete or isn\'t a valid PDF file'],
    [{ filename: 'chart.png', mimeType: 'image/png', content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]).toString('base64') }, 'chart.png is incomplete or isn\'t a valid PNG file'],
  ] as const)
    await expect(h.call('create_draft', { to: ['ann@example.com'], subject: 'Invoice', body: 'Attached.', attachments: [attachment] }))
      .rejects.toThrow(`Not called: the attachment ${label}, so the email would arrive without it. Create the draft with no attachments, then attach the file with UploadFile using destination.draftId. Nothing was created or sent.`);
  expect(h.requests).toHaveLength(0);
});

test('create_draft attaches a pasted data-URL or unpadded URL-safe file byte for byte', async () => {
  const h = harness(gmailTools, [{ id: 'r1', message: { id: 'm1', threadId: 't1' } }]);
  await h.call('create_draft', { subject: 'Invoice', body: 'Attached.', attachments: [
    { filename: 'invoice.pdf', content: `data:application/pdf;base64,${pdf.toString('base64')}` },
    { filename: 'copy.pdf', content: pdf.toString('base64url') },
  ] });
  const parsed = await PostalMime.parse(Buffer.from(h.requests[0]!.json.message.raw, 'base64url'));
  expect(parsed.attachments.map((attachment) => Buffer.from(attachment.content as ArrayBuffer))).toEqual([pdf, pdf]);
});

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

const profile = { emailAddress: 'me@gmail.com' };
const sendAs = { sendAs: [
  { sendAsEmail: 'me@gmail.com', isPrimary: true, displayName: 'Me Person', signature: '<div>Me<br>CEO</div>' },
  { sendAsEmail: 'Team@Example.com', displayName: 'Team Résumé', verificationStatus: 'accepted' },
  { sendAsEmail: 'pending@example.com', verificationStatus: 'pending' },
] };
const original = { id: 'msg-1', threadId: 'thread-9', payload: { mimeType: 'text/plain', headers: [
  { name: 'Message-ID', value: '<orig@example.com>' }, { name: 'From', value: 'Ann <ann@example.com>' },
  { name: 'Subject', value: 'Invoice' }, { name: 'Date', value: 'Mon, 12 Oct 2026 09:00:00 -0400' },
], body: { data: Buffer.from('What is the total?').toString('base64url') } } };

test('reviewed sending is hidden from Bots and verifies the account, aliases, signature and replied-to message', async () => {
  const h = harness(gmailTools, [profile, sendAs, { id: 'msg-1', threadId: 'thread-9', payload: { headers: [{ name: 'Subject', value: 'Invoice' }, { name: 'From', value: 'Ann <ann@example.com>' }] } }]);
  const tool = h.tools.find(t => t.name === 'send_reviewed_email')!;
  expect(tool._meta).toEqual({ 'openteam/hostOnly': true });
  const verified = await h.call('send_reviewed_email', { action: 'verify', draft: { from: 'team@example.com', to: ['ann@example.com'], subject: 'Re: Invoice', body: 'x', replyToMessageId: 'msg-1' } });
  expect(verified).toEqual({
    identity: 'me@gmail.com',
    sendingAddresses: ['me@gmail.com', 'team@example.com'],
    signatures: { 'me@gmail.com': '<div>Me<br>CEO</div>' },
    thread: '“Invoice” from Ann <ann@example.com>',
    threadUrl: 'https://mail.google.com/mail/u/me%40gmail.com/#all/thread-9',
  });
  expect(h.requests.map(r => r.url.pathname)).toEqual(['/profile', '/settings/sendAs', '/messages/msg-1']);
  expect(h.requests[2]!.url.searchParams.get('format')).toBe('metadata');
  const refused = harness(gmailTools, [profile, sendAs]);
  await expect(refused.call('send_reviewed_email', { action: 'verify', draft: { from: 'pending@example.com', to: ['a@example.com'], subject: 's', body: 'b' } })).rejects.toThrow("can't send as pending@example.com");
});

test('a reviewed reply goes out from the chosen address with its signature, threaded and quoted', async () => {
  const h = harness(gmailTools, [profile, sendAs, original, { id: 'sent-1', threadId: 'thread-9', labelIds: ['SENT'] }]);
  const result = await h.call('send_reviewed_email', { action: 'send', draft: {
    from: 'me@gmail.com', to: ['ann@example.com'], cc: ['bob@example.com'], subject: 'Re: Invoice', body: 'It is $1,250.',
    html: '<div dir="auto">It is $1,250.</div>', signatureHtml: '<div>Me<br>CEO</div>', replyToMessageId: 'msg-1',
  } });
  expect(result).toEqual({ id: 'sent-1', threadId: 'thread-9', labelIds: ['SENT'] });
  const send = h.requests.at(-1)!;
  expect(send.url.pathname).toBe('/messages/send');
  expect(send.json.threadId).toBe('thread-9');
  const parsed = await PostalMime.parse(Buffer.from(send.json.raw, 'base64url'));
  expect(parsed.from).toEqual({ name: 'Me Person', address: 'me@gmail.com' });
  expect(parsed.to?.map(a => a.address)).toEqual(['ann@example.com']);
  expect(parsed.cc?.map(a => a.address)).toEqual(['bob@example.com']);
  expect(parsed.subject).toBe('Re: Invoice');
  expect(parsed.inReplyTo).toBe('<orig@example.com>');
  expect(parsed.html).toContain('<div dir="auto">It is $1,250.</div><br><div dir="ltr" class="gmail_signature"><div>Me<br>CEO</div></div>');
  expect(parsed.html!.indexOf('gmail_signature')).toBeLessThan(parsed.html!.indexOf('<blockquote>'));
  expect(parsed.text).toContain('It is $1,250.\n\nMe\nCEO');
  expect(parsed.text).toContain('> What is the total?');
});

test('a reviewed forward verifies its source, appends forwarded context and sends previewed attachments in a new thread', async () => {
 const verified = harness(gmailTools, [profile, sendAs, original]);
 expect(await verified.call('send_reviewed_email', { action: 'verify', draft: {
  from: 'me@gmail.com', to: ['bob@example.com'], subject: 'Fwd: Invoice', body: 'Please review.', forwardMessageId: 'msg-1',
 } })).toMatchObject({ forwarding: '“Invoice” from Ann <ann@example.com>', forwardUrl: 'https://mail.google.com/mail/u/me%40gmail.com/#all/thread-9' });
 const h = harness(gmailTools, [profile, sendAs, original, { id: 'forward-1' }]);
 const bytes = Buffer.from('Reviewed attachment bytes.');
 await h.call('send_reviewed_email', { action: 'send', draft: {
  from: 'me@gmail.com', to: ['bob@example.com'], subject: 'Fwd: Invoice', body: 'Please review.', html: '<div>Please review.</div>',
  forwardMessageId: 'msg-1', attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', content: bytes.toString('base64') }],
 } });
 const sent = h.requests.at(-1)!;
 expect(sent.url.pathname).toBe('/messages/send');
 expect(sent.json.threadId).toBeUndefined();
 const parsed = await PostalMime.parse(Buffer.from(sent.json.raw, 'base64url'));
 expect(parsed.inReplyTo).toBeUndefined();
 expect(parsed.text).toContain('Please review.\n\n---------- Forwarded message ---------');
 expect(parsed.text).toContain('From: Ann <ann@example.com>');
 expect(parsed.text).toContain('Subject: Invoice');
 expect(parsed.text).toContain('What is the total?');
 expect(parsed.html).toContain('<blockquote>What is the total?</blockquote>');
 expect(parsed.attachments[0]?.filename).toBe('notes.txt');
 expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer)).toEqual(bytes);
});
