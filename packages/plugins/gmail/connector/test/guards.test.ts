import { expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { ToolNotes } from '../../../_shared/google';
import { harness } from '../../../test/parity-harness';
import { checkGmailAttachment, gmailAttachmentRefusal, GMAIL_ID_NOTES, GMAIL_SEARCH_EMPTY_NOTE, GMAIL_SEARCH_MORE_PAGES_NOTE, searchCoverageNote } from '../guards';
import { gmailTools } from '../server';
// Attachments and the reference implementation's verdicts on them (10-20 build).
import cases from './attachment-cases.json';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
const draftText = async (request: { json: any }) => (await PostalMime.parse(Buffer.from(request.json.message.raw, 'base64url'))).text;

test('attachment verdicts and refusals match the reference', () => {
  for (const { name, attachment, check, kind, refusal } of cases) {
    const verdict = checkGmailAttachment(attachment);
    expect([name, verdict.check, verdict.kind]).toEqual([name, check, kind]);
    if (refusal) expect(gmailAttachmentRefusal(verdict)).toBe(refusal);
  }
});

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

test('create_draft unwraps a hard-wrapped plain body before quoting the original; HTML bodies stay as written', async () => {
  const original = { id: 'message-1', threadId: 'thread-1', payload: { mimeType: 'text/plain', headers: [
    { name: 'Message-ID', value: '<original@example.com>' }, { name: 'From', value: 'ann@example.com' }, { name: 'Subject', value: 'Proposal' },
  ], body: { data: Buffer.from('Short original line\nsecond line').toString('base64url') } } };
  const h = harness(gmailTools, [original, { id: 'r1', message: { id: 'm1', threadId: 'thread-1' } }, { emailAddress: 'me@example.com' }, { id: 'r2', message: { id: 'm2' } }]);
  const wrapped = 'Thanks for sending over the revised proposal yesterday. I went through\nthe pricing section with the team this morning and we are aligned on\nthe overall structure.\n\nBest,\nRaghav';
  await h.call('create_draft', { replyToMessageId: 'message-1', body: wrapped });
  expect(await draftText(h.requests[1]!)).toStartWith('Thanks for sending over the revised proposal yesterday. I went through the pricing section with the team this morning and we are aligned on the overall structure.\n\nBest,\nRaghav\n\nOn ');
  expect(await draftText(h.requests[1]!)).toContain('> Short original line\n> second line');
  const html = 'Thanks for sending over the revised proposal yesterday. I went through<br>\nthe pricing section with the team this morning and we are aligned on';
  await h.call('create_draft', { body: html });
  expect(await draftText(h.requests[3]!)).toBe(html);
});

test('includeSignature appends the default send-as signature to both parts', async () => {
  const h = harness(gmailTools, [
    { sendAs: [{ sendAsEmail: 'alias@example.com', signature: 'Alias' }, { sendAsEmail: 'me@example.com', isDefault: true, signature: '<b>Ann Lee</b><br>Acme' }] },
    { id: 'r1', message: { id: 'm1' } },
  ]);
  await h.call('create_draft', { body: 'Hello', htmlBody: '<p>Hello</p>', includeSignature: true });
  const parsed = await PostalMime.parse(Buffer.from(h.requests[1]!.json.message.raw, 'base64url'));
  expect(parsed.text).toBe('Hello\n\nAnn Lee\nAcme');
  expect(parsed.html).toBe('<p>Hello</p><br><div dir="ltr" class="gmail_signature"><b>Ann Lee</b><br>Acme</div>');
  expect(h.requests[0]!.url.pathname).toBe('/settings/sendAs');
});

test('search coverage notes fire like the reference', () => {
  const empty = { threads: [] };
  const more = { threads: [{}], nextPageToken: 'next' };
  for (const [args, page, note] of [
    [{ query: 'invoice acme' }, empty, GMAIL_SEARCH_EMPTY_NOTE],
    [{ query: 'invoice acme', includeTrash: true }, empty, undefined],
    [{ query: 'in:anywhere invoice acme' }, empty, undefined],
    [{ query: 'subject:invoice', includeTrash: true }, empty, GMAIL_SEARCH_EMPTY_NOTE],
    [{ query: 'in:inbox invoice', includeTrash: true }, empty, GMAIL_SEARCH_EMPTY_NOTE],
    [{ query: 'from:billing@acme.com' }, more, GMAIL_SEARCH_MORE_PAGES_NOTE],
    [{ query: 'acme receipt' }, more, GMAIL_SEARCH_MORE_PAGES_NOTE],
    [{ query: 'is:unread' }, more, undefined],
    [{ query: 'older_than:1y in:inbox' }, more, undefined],
    [{ query: 'invoice acme', pageToken: 'p2' }, empty, undefined],
    [{ query: 'invoice acme' }, { threads: [{}] }, undefined],
  ] as const) expect(searchCoverageNote(args, page)).toBe(note);
});

test('search_threads adds the coverage note after the JSON result', async () => {
  const h = harness(gmailTools, [{ resultSizeEstimate: 0 }, { threads: [{ id: 't1' }] }, { emailAddress: 'me@example.com' }, { id: 't1', messages: [] }]);
  const empty = await h.call('search_threads', { query: 'subject:"order 1234"' });
  expect(empty).toBeInstanceOf(ToolNotes);
  expect(empty).toMatchObject({ value: {}, notes: [GMAIL_SEARCH_EMPTY_NOTE] });
  expect(h.requests[0]!.url.searchParams.get('q')).toBe('subject:"order 1234" -in:drafts');
  expect(await h.call('search_threads', { query: 'acme' })).toEqual({ threads: [{ id: 't1', messageCount: 0, messages: [] }] });
});

test('a thread, message or draft id Gmail cannot find names the id the tool takes', async () => {
  const missing = () => Response.json({ error: { message: 'Requested entity was not found.' } }, { status: 404 });
  const h = harness(gmailTools, [missing, missing, missing, () => Response.json({ error: { message: 'Invalid id value' } }, { status: 400 }), () => Response.json({ error: { message: 'Invalid label: Label_9' } }, { status: 400 })]);
  await expect(h.call('get_thread', { threadId: '18f0' })).rejects.toThrow(`Google API 404: Requested entity was not found.\n\n${GMAIL_ID_NOTES.thread}`);
  await expect(h.call('get_message', { messageId: '18f1' })).rejects.toThrow(GMAIL_ID_NOTES.message);
  await expect(h.call('get_draft', { draftId: 'r-1' })).rejects.toThrow(GMAIL_ID_NOTES.draft);
  await expect(h.call('trash_message', { messageId: 'bad' })).rejects.toThrow(`Google API 400: Invalid id value\n\n${GMAIL_ID_NOTES.message}`);
  // A bad label id is not a missing thread.
  expect(await h.call('label_thread', { threadId: '18f0', labelIds: ['Label_9'] }).catch((error: Error) => error.message)).toBe('Google API 400: Invalid label: Label_9');
});

test('Gmail serves Google\'s current tool texts', async () => {
  const { referenceTools } = await import('../../../_shared/reference');
  const byName = Object.fromEntries(gmailTools().map((tool) => [tool.name, tool]));
  const query = byName.search_threads!.inputSchema.properties.query.description;
  expect(query).toContain('`label:` — Under a specific label, matched by its display name (the `name` from `list_labels`), for example `label:wins`. Label IDs such as `Label_123` match nothing.');
  expect(byName.search_threads!.description).toContain('`messageCount` (total messages in the thread), `viewUrl`, and a subset of up to 5 related messages');
  expect(byName.create_draft!.inputSchema.properties.includeSignature).toEqual({ type: 'boolean', description: 'Optional. Whether to append the user\'s configured Gmail web signature to the draft. Defaults to false.' });
  for (const reference of referenceTools.gmail) {
    const served = byName[reference.name]!;
    expect([reference.name, served.description]).toEqual([reference.name, reference.description]);
    for (const [key, property] of Object.entries(reference.inputSchema.properties)) expect(served.inputSchema.properties[key]).toEqual(property);
  }
});

test('drafts carry the Gmail web link Google gives them, and a failed lookup leaves it out', async () => {
  const saved = { id: 'r-6712453555673774501', message: { id: '1a16a657441ae031', threadId: '1a16a657441ae031' } };
  const url = 'https://mail.google.com/mail/?authuser=me@example.com#all?compose=thread-f:1879872788208738353%2Bmsg-a:r-6712453555673774501';
  const h = harness(gmailTools, [saved, { emailAddress: 'me@example.com' }, saved, saved]);
  expect(await h.call('create_draft', { body: 'Hi' })).toEqual({ id: saved.id, messageId: saved.message.id, threadId: saved.message.threadId, viewUrl: url });
  expect((await h.call('get_draft', { draftId: saved.id, messageFormat: 'MINIMAL' })).viewUrl).toBe(url);
  expect((await h.call('get_draft', { draftId: saved.id, messageFormat: 'RAW' })).viewUrl).toBeUndefined();
  const failed = harness(gmailTools, [saved, () => Response.json({ error: { message: 'unavailable' } }, { status: 503 })]);
  expect(await failed.call('create_draft', { body: 'Hi' })).toEqual({ id: saved.id, messageId: saved.message.id, threadId: saved.message.threadId });
});

const savedDraft = (parts: any[]) => ({ id: 'r-1', message: { id: 'm-1', threadId: 'thread-1', payload: { mimeType: 'multipart/mixed', headers: [
  { name: 'To', value: 'Ann Lee <ann@example.com>' }, { name: 'Cc', value: 'bob@example.com' }, { name: 'Subject', value: 'Re: Proposal' },
  { name: 'In-Reply-To', value: '<original@example.com>' }, { name: 'References', value: '<root@example.com> <original@example.com>' },
], parts } } });
const textPart = (mimeType: string, text: string) => ({ mimeType, body: { data: Buffer.from(text).toString('base64url') } });
const savedParts = [
  { mimeType: 'multipart/alternative', parts: [textPart('text/plain', 'Old body'), textPart('text/html', '<p>Old body</p>')] },
  { mimeType: 'application/pdf', filename: 'old.pdf', body: { attachmentId: 'a-1' } },
];

test('update_draft merges like Google: given fields replace, omitted ones stay, attachments are not merged', async () => {
  const h = harness(gmailTools, [savedDraft(savedParts), { id: 'r-1', message: { id: 'm-2', threadId: 'thread-1' } }]);
  const result = await h.call('update_draft', { draftId: 'r-1', to: [], body: 'We reviewed the contract terms with legal on Monday and they asked us to\nadd a clause about data retention.' });
  expect(result).toEqual({ id: 'r-1', messageId: 'm-2', threadId: 'thread-1' });
  const put = h.requests[1]!;
  expect([put.init.method, put.url.pathname, put.json.id, put.json.message.threadId]).toEqual(['PUT', '/drafts/r-1', 'r-1', 'thread-1']);
  const parsed = await PostalMime.parse(Buffer.from(put.json.message.raw, 'base64url'));
  expect(parsed.to?.map((entry) => entry.address)).toEqual(['ann@example.com']);
  expect(parsed.cc?.map((entry) => entry.address)).toEqual(['bob@example.com']);
  expect(parsed.subject).toBe('Re: Proposal');
  expect(parsed.inReplyTo).toBe('<original@example.com>');
  expect(parsed.references).toBe('<root@example.com> <original@example.com>');
  expect(parsed.text).toBe('We reviewed the contract terms with legal on Monday and they asked us to add a clause about data retention.');
  expect(parsed.html).toBeUndefined();
  expect(parsed.attachments).toHaveLength(0);
});

test('update_draft keeps both bodies when neither is given, and clears the plain one for an HTML-only update', async () => {
  const h = harness(gmailTools, [savedDraft(savedParts), { id: 'r-1', message: { id: 'm-2' } }, { emailAddress: 'me@example.com' }, savedDraft(savedParts), { id: 'r-1', message: { id: 'm-3' } }]);
  await h.call('update_draft', { draftId: 'r-1', subject: 'Re: Proposal v2', attachments: [{ filename: 'new.pdf', content: pdf.toString('base64') }] });
  const kept = await PostalMime.parse(Buffer.from(h.requests[1]!.json.message.raw, 'base64url'));
  expect([kept.subject, kept.text, kept.html, kept.attachments.map((a) => a.filename)]).toEqual(['Re: Proposal v2', 'Old body', '<p>Old body</p>', ['new.pdf']]);
  await h.call('update_draft', { draftId: 'r-1', htmlBody: '<p>New</p>' });
  const html = await PostalMime.parse(Buffer.from(h.requests[4]!.json.message.raw, 'base64url'));
  expect([html.html, html.text]).toEqual(['<p>New</p>', undefined]);
});

test('delete_draft removes the draft; a stale draft id gets the draft note', async () => {
  const h = harness(gmailTools, [new Response(null, { status: 204 }), () => Response.json({ error: { message: 'Requested entity was not found.' } }, { status: 404 })]);
  expect(await h.call('delete_draft', { draftId: 'r-1' })).toEqual({ success: true });
  expect([h.requests[0]!.init.method, h.requests[0]!.url.pathname]).toEqual(['DELETE', '/drafts/r-1']);
  await expect(h.call('update_draft', { draftId: 'm-1', subject: 'x' })).rejects.toThrow(GMAIL_ID_NOTES.draft);
});
