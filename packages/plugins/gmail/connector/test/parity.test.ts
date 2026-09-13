import { expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { gmailTools } from '../server';
import { normalizeMessage } from '../messages';
import { harness } from '../../../test/parity-harness';

const source = { id: 'message-1', threadId: 'thread-1', labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [
  { name: 'Message-ID', value: '<original@example.com>' }, { name: 'References', value: '<ancestor@example.com>' },
  { name: 'From', value: 'Sender <sender@example.com>' }, { name: 'Reply-To', value: 'reply@example.com' },
  { name: 'Subject', value: 'A résumé' }, { name: 'Date', value: 'Sat, 12 Sep 2026 09:00:00 -0400' },
], body: { data: Buffer.from('Original message 🌎').toString('base64url') } } };

test('Gmail builds a real multipart HTML reply with thread headers, Unicode and byte-exact attachments', async () => {
  const attachment = Buffer.from([0, 255, 1, 13, 10, 240]);
  const h = harness(gmailTools, [source, { id: 'draft-1', message: { id: 'new-message', threadId: 'thread-1' } }]);
  const result = await h.call('create_draft', { replyToMessageId: 'message-1', body: 'My reply', htmlBody: '<b>My reply</b><img src="cid:chart.png">',
    attachments: [{ filename: 'chart.png', mimeType: 'image/png', content: attachment.toString('base64'), inline: true }, { filename: 'résumé.bin', content: attachment.toString('base64') }] });
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
  await expect(h.call('create_draft', { attachments: [{ filename: 'x', content: 'invalid!' }] })).rejects.toThrow('base64');
  expect(h.requests).toHaveLength(1);
});

test('Gmail decodes MIME text and headers, supplies HTML-to-text, and honors metadata privacy', async () => {
  const raw = { ...source, payload: { ...source.payload, mimeType: 'text/html', headers: [...source.payload.headers, {name:'To',value:'"Doe, Jane" <jane@example.com>, second@example.com'}, {name:'Subject', value:'=?UTF-8?B?UsOpc3Vtw6k=?='}], body: { data: Buffer.from('<p>Hello <b>world</b> &amp; everyone</p>').toString('base64url') } } };
  expect(normalizeMessage(raw,'PLAIN_TEXT')).toMatchObject({ subject:'Résumé', plaintextBody:'Hello world & everyone', toRecipients:['jane@example.com','second@example.com'] });
  expect(normalizeMessage(raw,'PLAIN_TEXT').htmlBody).toBeUndefined();
  expect(normalizeMessage(raw,'METADATA_ONLY').subject).toBeUndefined();
  expect(normalizeMessage(raw,'METADATA_ONLY').plaintextBody).toBeUndefined();
  expect(normalizeMessage(raw).htmlBody).toContain('<b>world</b>');
});

test('Gmail fetches externally stored text MIME parts and normalizes draft IDs', async () => {
  const h=harness(gmailTools,[{id:'draft',message:{...source,payload:{mimeType:'text/plain',body:{attachmentId:'text-body'}}}},{data:Buffer.from('Long message body').toString('base64url')}]);
  const result=await h.call('get_draft',{draftId:'draft'});
  expect(result).toMatchObject({id:'draft',messageId:'message-1',plaintextBody:'Long message body'});
  expect(h.requests[1]!.url.pathname).toBe('/messages/message-1/attachments/text-body');
});

test('Gmail search and draft lists return useful message metadata and real pagination', async () => {
  const h=harness(gmailTools,[{threads:[{id:'thread-1'}],nextPageToken:'next'},{id:'thread-1',messages:[source,{...source,id:'draft-msg',labelIds:['DRAFT']}]},{drafts:[{id:'draft'}],nextPageToken:'draft-next'},{id:'draft',message:source}]);
  const search=await h.call('search_threads',{query:'from:sender',includeTrash:true,pageSize:4,view:'THREAD_VIEW_METADATA_ONLY'});
  expect(h.requests[0]!.url.searchParams.get('includeSpamTrash')).toBe('true');
  expect(search.nextPageToken).toBe('next');
  expect(search.threads[0].messages).toHaveLength(1);
  expect(search.threads[0].messages[0].subject).toBeUndefined();
  const drafts=await h.call('list_drafts',{query:'subject:résumé',view:'DRAFT_VIEW_FULL',pageSize:7});
  expect(h.requests[2]!.url.searchParams.get('q')).toBe('subject:résumé');
  expect(drafts.drafts[0].plaintextBody).toBe('Original message 🌎');
});

test('Gmail label hierarchy, presets and visibility map to actual REST settings', async () => {
  const h=harness(gmailTools,[{labels:[{id:'a',name:'Projects'}]},{id:'b',name:'Projects/Alpha'},{id:'c',name:'Projects/Alpha/Sprint',type:'user',color:{backgroundColor:'#4a86e8',textColor:'#ffffff'},labelListVisibility:'labelShowIfUnread',messageListVisibility:'hide'}]);
  const label=await h.call('create_label',{displayName:'Projects/Alpha/Sprint',colorPreset:'LABEL_COLOR_PRESET_BLUE',labelListVisibility:'LABEL_SHOW_IF_UNREAD',messageListVisibility:'HIDE'});
  expect(h.requests[1]!.json).toEqual({name:'Projects/Alpha'});
  expect(h.requests[2]!.json).toMatchObject({name:'Projects/Alpha/Sprint',color:{backgroundColor:'#4a86e8',textColor:'#ffffff'},labelListVisibility:'labelShowIfUnread',messageListVisibility:'hide'});
  expect(label).toMatchObject({labelId:'c',labelType:'USER',colorPreset:'LABEL_COLOR_PRESET_BLUE'});
});

test('Gmail sensitive-label inputs use reversible trash and spam operations', async () => {
  const h=harness(gmailTools,[{},{}]);
  await h.call('apply_sensitive_message_label',{messageId:'m',labelOption:'TRASH'});
  await h.call('apply_sensitive_thread_label',{threadId:'t',labelOption:'SPAM'});
  expect(h.requests[0]!.url.pathname).toBe('/messages/m/trash');
  expect(h.requests[1]!.json).toEqual({addLabelIds:['SPAM'],removeLabelIds:['INBOX']});
});
