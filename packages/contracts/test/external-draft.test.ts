import { test, expect } from 'bun:test';
import { editExternalDraft, externalDraftAllowList, externalDraftApprovalMode, externalDraftHtml, parseExternalDraft } from '../src/external-draft';
test('draft HTML preserves prose while escaping active markup and URL delimiters', () => {
 expect(externalDraftHtml('Hello\r\n<script>alert(1)</script>\nSee https://example.com/a?q=1&b=2.')).toBe('<div dir="auto">Hello<br>&lt;script&gt;alert(1)&lt;/script&gt;<br>See <a href="https://example.com/a?q=1&amp;b=2">https://example.com/a?q=1&amp;b=2</a>.</div>');
 expect(externalDraftHtml('(https://example.com/a)')).toBe('<div dir="auto">(<a href="https://example.com/a">https://example.com/a</a>)</div>');
 expect(externalDraftHtml('**Literal prose** javascript:alert(1)')).toBe('<div dir="auto">**Literal prose** javascript:alert(1)</div>');
});

test('approval mode follows the Bot settings and the card recipients', () => {
 const draft = { platform: 'email' as const, to: ['Ann@Example.com'], cc: ['bob@example.com'] };
 expect(externalDraftApprovalMode({ draftingDisabled: false, draftAllowedRecipients: [] }, draft)).toBe('needs-approval');
 expect(externalDraftApprovalMode({ draftingDisabled: false, draftAllowedRecipients: ['ann@example.com'] }, draft)).toBe('needs-approval');
 expect(externalDraftApprovalMode({ draftingDisabled: false, draftAllowedRecipients: ['ann@example.com', 'BOB@example.com'] }, draft)).toBe('always-allow');
 expect(externalDraftApprovalMode({ draftingDisabled: true, draftAllowedRecipients: [] }, draft)).toBe('disable-drafts');
 expect(externalDraftApprovalMode({ draftingDisabled: false, draftAllowedRecipients: ['ann@example.com'] }, { platform: 'slack' })).toBe('needs-approval');
 expect(externalDraftAllowList(['carol@example.com'], draft, 'always-allow')).toEqual(['carol@example.com', 'ann@example.com', 'bob@example.com']);
 expect(externalDraftAllowList(['carol@example.com', 'ann@example.com', 'bob@example.com'], draft, 'needs-approval')).toEqual(['carol@example.com']);
 expect(externalDraftAllowList(['Carol@example.com'], draft, 'disable-drafts')).toEqual(['carol@example.com']);
});

test('From may change only among the verified addresses', () => {
 const saved = { platform: 'email' as const, providerIdentifier: 'p', from: 'me@example.com', to: ['ann@example.com'], subject: 'Hi', body: 'Hello' };
 expect(editExternalDraft(saved, { from: 'alias@example.com' }, ['me@example.com', 'alias@example.com']).from).toBe('alias@example.com');
 expect(() => editExternalDraft(saved, { from: 'someone@example.com' }, ['me@example.com'])).toThrow('verified addresses');
 expect(() => editExternalDraft(saved, { providerIdentifier: 'q' })).toThrow('cannot be changed');
});

test('waitForReview is an optional boolean that survives edits', () => {
 const saved = parseExternalDraft({ platform: 'email', providerIdentifier: 'p', from: 'me@example.com', to: ['ann@example.com'], subject: 'Hi', body: 'Hello', waitForReview: true });
 expect(saved.waitForReview).toBe(true);
 expect(editExternalDraft(saved, { body: 'Edited' }).waitForReview).toBe(true);
 expect(parseExternalDraft({ ...saved, waitForReview: false }).waitForReview).toBeUndefined();
 expect(() => parseExternalDraft({ ...saved, waitForReview: 'yes' })).toThrow('waitForReview');
});

test('the main-tool parser keeps waitForReview and the captured draft rules', async () => {
 const { normalizeMainToolArguments } = await import('../src/reference-main-parsers');
 const args = { platform: 'email', providerIdentifier: 'p', from: 'me@example.com', to: ['ann@example.com'], subject: 'Hi', body: 'Hello', waitForReview: true };
 expect(normalizeMainToolArguments('DraftExternalMessage', args)).toMatchObject({ waitForReview: true });
 expect(() => normalizeMainToolArguments('DraftExternalMessage', { ...args, channelId: 'C123456789' })).toThrow('only valid with platform:slack');
});

test('a model email draft is unwrapped once; Slack drafts and user edits keep their lines', async () => {
 const { parseDraftExternalMessage } = await import('../src/external-draft-body');
 const wrapped = 'Thanks for sending over the revised proposal yesterday. I went through\nthe pricing section with the team this morning and we are aligned on\nthe overall structure.\n\nBest,\nRaghav';
 const email = { platform: 'email', providerIdentifier: 'p', from: 'me@example.com', to: ['ann@example.com'], subject: 'Hi', body: wrapped };
 expect(parseDraftExternalMessage(email).body).toBe('Thanks for sending over the revised proposal yesterday. I went through the pricing section with the team this morning and we are aligned on the overall structure.\n\nBest,\nRaghav');
 expect(parseExternalDraft(email).body).toBe(wrapped);
 expect(editExternalDraft(parseExternalDraft(email), { body: wrapped }).body).toBe(wrapped);
 const slack = { platform: 'slack', providerIdentifier: 'p', target: '#general', channelId: 'C0123456789', body: wrapped };
 expect(parseDraftExternalMessage(slack).body).toBe(wrapped);
});

test('HTML in an email body and Slack markup in a Slack body are refused before a card exists', async () => {
 const { parseDraftExternalMessage, slackBodyProblems } = await import('../src/external-draft-body');
 const { normalizeMainToolArguments } = await import('../src/reference-main-parsers');
 const email = { platform: 'email', providerIdentifier: 'p', from: 'me@example.com', to: ['ann@example.com'], subject: 'Hi', body: '<p>Hello Dana,</p><p>See you Friday.</p>' };
 const html = 'body is plain text, so </p> would reach the recipient as literal text. Nothing was drafted. Rewrite body as plain text: blank lines between paragraphs, "- " before list items.';
 expect(() => parseDraftExternalMessage(email)).toThrow(html);
 expect(() => normalizeMainToolArguments('DraftExternalMessage', email)).toThrow('body is plain text, so </p> would reach the recipient as literal text. Nothing was drafted.');
 expect(parseDraftExternalMessage({ ...email, body: 'Is 3 < 5 > 2? Yes.' }).body).toBe('Is 3 < 5 > 2? Yes.');
 const slack = { platform: 'slack', providerIdentifier: 'p', target: '#general', channelId: 'C0123456789' };
 expect(() => parseDraftExternalMessage({ ...slack, body: '• one\n• two' })).toThrow(
  'body is standard markdown that is converted for Slack, so Slack\'s own syntax in it would not render as written. Nothing was drafted. Fix body and call this tool again: start each list item with "- ", not •.');
 expect(() => parseDraftExternalMessage({ ...slack, body: '• See <https://x.com|x>\n```js run this\ncode\n```' })).toThrow(
  'Fix body and call this tool again: write each link as [label](url), not <url|label>; start each list item with "- ", not •; put each ``` of a code block on its own line, with nothing after the opening one but an optional language name.');
 expect(parseDraftExternalMessage({ ...slack, body: '- one\n- two [x](https://x.com)\n```js\nconst a = "• <https://a.b|c>";\n```' }).body).toContain('- one');
 // Cases checked against the reference implementation.
 for (const [body, problems] of [
  ['```js\ncode\n```', []], ['text ```\ncode\n```', ['fence_text']], ['```\ncode\n``` after', ['fence_text']],
  ['`• inline` fine', []], ['``` code ```', []], ['~~~\n• inside\n~~~', []], ['```\n<https://a.b|c>\n```', []],
 ] as const) expect([...slackBodyProblems(body)]).toEqual([...problems]);
});
