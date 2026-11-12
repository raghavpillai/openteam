import { expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { harness } from '../../../test/parity-harness';
import { gmailTools } from '../server';
// Attachments and the reference implementation's verdicts on them (10-20 build).

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

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
