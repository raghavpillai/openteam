import { expect, test } from 'bun:test';
import { matchesAutomationEvent as match, parseAutomationEvent } from '../src/automation-events';
import { parseStoredTrigger } from '../src/automation-trigger';
const event = { id: 'delivery', source: 'github' as const, kind: 'ci-failed', text: 'Tests failed', repo: 'org/repo', actor: 'Alice', branch: 'main' };
test('event matching respects source, repo, author, branch, OR listeners, and target-specific filters', () => {
 const github = parseStoredTrigger({ type: 'github', repo: 'org/repo', events: ['ci-failed'], ciBranch: 'main', userAllowlist: ['alice'] });
 expect(match(github, event)).toBe(true); expect(match(github, { ...event, actor: 'Mallory' })).toBe(false); expect(match(github, { ...event, branch: 'other' })).toBe(false);
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
