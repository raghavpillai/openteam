import { expect, test } from 'bun:test';
import type { ExternalDraft } from '../src/external-draft';
import { draftRevision } from '../src/external-draft-revision';

const draft: ExternalDraft = { platform: 'email', providerIdentifier: 'gmail', from: 'me@example.com', to: ['ann@example.com'], subject: 'Schedule', body: 'Hi Ann,\n\nThe meeting is on Monday at ten. Please bring the project notes.\n\nThanks!' };
const previous = { id: 'old', turn: 1, draft };
test('small revisions preserve exact text and highlight added words and changed fields', () => {
 const body = draft.body.replace('Monday at ten', 'Tuesday at eleven');
 const revision = draftRevision({ ...draft, body, subject: 'Updated schedule', cc: ['bob@example.com'] }, [previous])!;
 expect(revision.baselineMessageId).toBe('old');
 expect(revision.changedFields).toEqual(['cc', 'subject']);
 expect(revision.body.map(part => part.text).join('')).toBe(body);
 expect(revision.body.filter(part => part.added).map(part => part.text).join(' ')).toContain('Tuesday');
 expect(revision.body.filter(part => part.added).map(part => part.text).join(' ')).toContain('eleven');
 expect(revision.body.filter(part => part.added).map(part => part.text).join(' ')).not.toContain('project notes');
});
test('unrelated routes, large rewrites, current turns and ambiguous candidates are not highlighted', () => {
 expect(draftRevision({ ...draft, body: 'A completely unrelated email about a different topic.' }, [previous])).toBeUndefined();
 expect(draftRevision({ ...draft, body: draft.body + ' See you.' }, [{ ...previous, draft: { ...draft, providerIdentifier: 'other' } }])).toBeUndefined();
 expect(draftRevision({ ...draft, body: draft.body + ' See you.' }, [{ ...previous, turn: 0 }])).toBeUndefined();
 expect(draftRevision({ ...draft, body: draft.body + ' See you.' }, [previous, { ...previous, id: 'duplicate' }])).toBeUndefined();
 expect(draftRevision(draft, [previous])).toBeUndefined();
});
test('matching recipient disambiguates similar drafts and large inputs stay bounded', () => {
 const updated = { ...draft, body: draft.body.replace('Monday', 'Friday') };
 expect(draftRevision(updated, [previous, { ...previous, id: 'other', draft: { ...draft, to: ['bob@example.com'] } }])?.baselineMessageId).toBe('old');
 const body = 'long text '.repeat(5000);
 expect(draftRevision({ ...draft, body: 'replacement '.repeat(10000) }, [{ ...previous, draft: { ...draft, body } }])).toBeUndefined();
});
