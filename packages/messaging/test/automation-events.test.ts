import { expect, test } from 'bun:test';
import { matchesAutomationEvent as match, parseAutomationEvent } from '../src/automation-events';
import { parseStoredTrigger } from '../src/automation-trigger';
const event = { id: 'delivery', source: 'github' as const, kind: 'ci-failed', text: 'Tests failed', repo: 'org/repo', actor: 'Alice', branch: 'main' };
test('event matching respects source, repo, branch, OR listeners, and target-specific filters', () => {
 const github = parseStoredTrigger({ type: 'github', repo: 'org/repo', events: ['ci-failed'], ciBranch: 'main', userAllowlist: ['alice'] });
 expect(match(github, event)).toBe(true); expect(match(github, { ...event, branch: 'other' })).toBe(false);
 // CI is never user-gated.
 expect(match(github, { ...event, actor: 'Mallory' })).toBe(true);
 expect(match({ type: 'group', listeners: [{ type: 'cron', schedule: '@daily' }, github] }, event)).toBe(true);
 const slack = parseStoredTrigger({ type: 'slack', channel: '#eng', match: { kind: 'reaction', emoji: ['eyes'], bySelf: true } });
 expect(match(slack, { id: '1', source: 'slack', kind: 'reaction', text: '', channel: '#eng', emoji: ':eyes:', bySelf: true })).toBe(true);
 expect(match(slack, { id: '1', source: 'slack', kind: 'reaction', text: '', channel: '#eng', emoji: 'eyes' })).toBe(false);
 const teams = parseStoredTrigger({ type: 'microsoftTeams', tenantId: 'a', teamIds: ['b'], messageContains: '^deploy', messageContainsIsRegex: true, blockUnauthenticatedTeamsUsers: true });
 expect(match(teams, { id: '1', source: 'microsoftTeams', kind: 'message', text: 'Deploy failed', tenantId: 'a', teamId: 'b', authenticatedUser: true })).toBe(true);
 expect(match(teams, { id: '1', source: 'microsoftTeams', kind: 'message', text: 'Deploy failed', tenantId: 'a', teamId: 'b' })).toBe(false);
 expect(match({ type: 'linear', event: { case: 'statusChanged', statusIds: ['done'] }, projectIds: ['project'] }, { id: '1', source: 'linear', kind: 'statusChanged', text: '', statusId: 'done', projectId: 'other' })).toBe(false);
 expect(() => parseAutomationEvent({ ...event, text: 'x'.repeat(32_001) })).toThrow();
});
test('a GitHub allowlist gates the user who drives each event kind', () => {
 const listener = parseStoredTrigger({ type: 'github', repo: 'org/repo', pr: 7, userAllowlist: ['@Me'],
  events: ['pr-pushed', 'pr-comment', 'review-approved', 'review-thread-resolved', 'issue-assigned', 'ci-failed'] });
 const pr = { id: 'd', source: 'github' as const, text: '', repo: 'org/repo', pr: 7 };
 // PR and comment events: the PR author, whoever pushed or commented.
 expect(match(listener, { ...pr, kind: 'pr-pushed', actor: 'teammate', prOwner: 'me' })).toBe(true);
 expect(match(listener, { ...pr, kind: 'pr-comment', actor: 'me', prOwner: 'teammate' })).toBe(false);
 // Review events: the reviewer or the PR author.
 expect(match(listener, { ...pr, kind: 'review-approved', actor: 'reviewer', prOwner: 'me' })).toBe(true);
 expect(match(listener, { ...pr, kind: 'review-thread-resolved', actor: 'me', prOwner: 'teammate' })).toBe(true);
 expect(match(listener, { ...pr, kind: 'review-approved', actor: 'reviewer', prOwner: 'teammate' })).toBe(false);
 // Assignments: the assigner. CI: never gated. A missing identity fails closed.
 expect(match(listener, { ...pr, kind: 'issue-assigned', actor: 'me' })).toBe(true);
 expect(match(listener, { ...pr, kind: 'ci-failed', actor: 'github-actions' })).toBe(true);
 expect(match(listener, { ...pr, kind: 'pr-pushed', actor: 'me' })).toBe(false);
 expect(parseAutomationEvent({ ...pr, kind: 'pr-pushed', prOwner: 'me' }).prOwner).toBe('me');
});
test('email triggers match the receiving inbox, sender allowlist, and sender authentication', () => {
 const mail = { id: 'bot@example.com:7:42', source: 'email' as const, kind: 'received', text: 'Subject: Hi', channel: 'Bot@Example.com', actor: 'Alice@Partner.com', authenticatedUser: true };
 const any = parseStoredTrigger({ type: 'email', inbox: 'BOT@example.com' });
 expect(any).toEqual({ type: 'email', inbox: 'bot@example.com' });
 expect(match(any, mail)).toBe(true);
 expect(match(any, { ...mail, channel: 'other@example.com' })).toBe(false);
 expect(match(any, { ...mail, authenticatedUser: false })).toBe(false);
 expect(match(any, { ...mail, authenticatedUser: undefined })).toBe(false);
 const unauthenticated = parseStoredTrigger({ type: 'email', inbox: 'bot@example.com', requireAuthPass: false });
 expect(match(unauthenticated, { ...mail, authenticatedUser: false })).toBe(true);
 const allowlist = parseStoredTrigger({ type: 'email', inbox: 'bot@example.com', from: ['alice@partner.com', 'ALICE@partner.com', '@raghav.sh'] });
 expect(allowlist).toEqual({ type: 'email', inbox: 'bot@example.com', from: ['alice@partner.com', '@raghav.sh'] });
 expect(match(allowlist, mail)).toBe(true);
 expect(match(allowlist, { ...mail, actor: 'me@raghav.sh' })).toBe(true);
 expect(match(allowlist, { ...mail, actor: 'mallory@notraghav.sh' })).toBe(false);
 expect(match(allowlist, { ...mail, actor: 'bob@partner.com' })).toBe(false);
 expect(match({ type: 'group', listeners: [{ type: 'cron', schedule: '@daily' }, allowlist] }, mail)).toBe(true);
 expect(match(any, { ...mail, source: 'webhook' })).toBe(false);
 expect(parseAutomationEvent(mail).source).toBe('email');
});
test('email triggers reject malformed inboxes, senders, and flags', () => {
 expect(() => parseStoredTrigger({ type: 'email' })).toThrow('trigger.inbox');
 expect(() => parseStoredTrigger({ type: 'email', inbox: 'not-an-address' })).toThrow('inbox must be an email address');
 expect(() => parseStoredTrigger({ type: 'email', inbox: 'bot@example.com', from: 'alice@example.com' })).toThrow('list of addresses');
 expect(() => parseStoredTrigger({ type: 'email', inbox: 'bot@example.com', from: ['alice'] })).toThrow('addresses or @domains');
 expect(() => parseStoredTrigger({ type: 'email', inbox: 'bot@example.com', requireAuthPass: 'no' })).toThrow('requireAuthPass');
 expect(() => parseStoredTrigger({ type: 'group', listeners: [{ type: 'origin', repo: 'o/r', events: ['pr-opened'] }, { type: 'email', inbox: 'bot@example.com' }] })).toThrow('email');
});
