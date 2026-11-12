import { expect, spyOn, test } from 'bun:test';
import nodemailer from 'nodemailer';
import PostalMime from 'postal-mime';
import { Mailbox } from '../mailbox';
import { tools } from '../server';
import { parseEndpoint, type MailSettings } from '../settings';

test('SMTP reviewed forwards show their source and carry reviewed files without reply threading', async () => {
 const settings: MailSettings = { address: 'me@example.com', username: 'me@example.com', password: 'test', owners: [], detectedBy: 'test',
  imap: parseEndpoint('imap://127.0.0.1:1', 'imap'), smtp: parseEndpoint('smtp://smtp.gmail.com:25', 'smtp') };
 const mailbox = new Mailbox(settings);
 const source = { subject: 'Invoice', from: { name: 'Ann', address: 'ann@example.com' }, to: [{ address: 'me@example.com' }],
  text: 'Original invoice contents.', html: '<p>Original invoice contents.</p>', date: '2026-11-12', messageId: '<original@example.com>' };
 Object.assign(mailbox, { session: async (work: (client: unknown) => Promise<unknown>) => work({}), load: async () => ({ parsed: source }) });
 const sent: Buffer[] = [];
 const transport = spyOn(nodemailer, 'createTransport').mockImplementation(() => ({
  sendMail: async ({ raw }: { raw: Buffer }) => { sent.push(raw); return { accepted: ['bob@example.com'], rejected: [] }; },
  close() {},
 }) as never);
 try {
  const tool = tools('account').find(tool => tool.name === 'send_reviewed_email')!;
  const context = { mailbox, settings, accountId: 'account' };
  const draft = { from: settings.address, to: ['bob@example.com'], subject: 'Fwd: Invoice', body: 'Please review.', html: '<p>Please review.</p>',
   forwardMessageId: 'INBOX:1', attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', content: Buffer.from('Reviewed bytes.').toString('base64') }] };
  expect(await tool.run(context, { action: 'verify', draft })).toMatchObject({ forwarding: '“Invoice” from Ann <ann@example.com>' });
  await tool.run(context, { action: 'send', draft });
  const parsed = await PostalMime.parse(sent[0]!);
  expect(parsed.subject).toBe('Fwd: Invoice');
  expect(parsed.inReplyTo).toBeUndefined();
  expect(parsed.text).toContain('From: Ann <ann@example.com>');
  expect(parsed.text).toContain('Original invoice contents.');
  expect(parsed.html).toContain('<blockquote><p>Original invoice contents.</p></blockquote>');
  expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer).toString()).toBe('Reviewed bytes.');
  Object.assign(mailbox, { load: async () => { throw new Error('Original message not found'); } });
  await expect(tool.run(context, { action: 'send', draft })).rejects.toThrow('not found');
  expect(sent).toHaveLength(1);
 } finally { transport.mockRestore(); }
});
