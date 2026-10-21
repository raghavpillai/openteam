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
  const h = harness(gmailTools, [original, { id: 'r1', message: { id: 'm1', threadId: 'thread-1' } }, { id: 'r2', message: { id: 'm2' } }]);
  const wrapped = 'Thanks for sending over the revised proposal yesterday. I went through\nthe pricing section with the team this morning and we are aligned on\nthe overall structure.\n\nBest,\nRaghav';
  await h.call('create_draft', { replyToMessageId: 'message-1', body: wrapped });
  expect(await draftText(h.requests[1]!)).toStartWith('Thanks for sending over the revised proposal yesterday. I went through the pricing section with the team this morning and we are aligned on the overall structure.\n\nBest,\nRaghav\n\nOn ');
  expect(await draftText(h.requests[1]!)).toContain('> Short original line\n> second line');
  const html = 'Thanks for sending over the revised proposal yesterday. I went through<br>\nthe pricing section with the team this morning and we are aligned on';
  await h.call('create_draft', { body: html });
  expect(await draftText(h.requests[2]!)).toBe(html);
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
  const h = harness(gmailTools, [{ resultSizeEstimate: 0 }, { threads: [{ id: 't1' }] }, { id: 't1', messages: [] }]);
  const empty = await h.call('search_threads', { query: 'subject:"order 1234"' });
  expect(empty).toBeInstanceOf(ToolNotes);
  expect(empty).toMatchObject({ value: { threads: [] }, notes: [GMAIL_SEARCH_EMPTY_NOTE] });
  expect(h.requests[0]!.url.searchParams.get('q')).toBe('subject:"order 1234" -in:drafts');
  expect(await h.call('search_threads', { query: 'acme' })).toEqual({ threads: [{ id: 't1', messages: [] }] });
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

test('Gmail serves Google\'s current label:, body and includeSignature texts', () => {
  const byName = Object.fromEntries(gmailTools().map((tool) => [tool.name, tool]));
  const query = byName.search_threads!.inputSchema.properties.query.description;
  expect(query).toContain('`label:` — Under a specific label, matched by its display name (the `name` from `list_labels`), for example `label:wins`. Label IDs such as `Label_123` match nothing.');
  expect(query).not.toContain('The tool accepts label IDs');
  expect(byName.search_threads!.description).toContain('use the `category:` operator with `primary`, `social`, `promotions`, `updates`, or `forums`');
  expect(byName.create_draft!.description).toContain('Plain text body content can be provided in `body` (do NOT format `body` with Markdown)');
  expect(byName.create_draft!.description).toContain('Set `includeSignature` to true to append the user\'s configured Gmail web signature to the draft.');
  expect(byName.create_draft!.inputSchema.properties.body.description).toStartWith('Optional. The plain text body content of the email draft. Do NOT format this field with Markdown');
  expect(byName.create_draft!.inputSchema.properties.includeSignature).toEqual({ type: 'boolean', description: 'Optional. Whether to append the user\'s configured Gmail web signature to the draft. Defaults to false.' });
});
