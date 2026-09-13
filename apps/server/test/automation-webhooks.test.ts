import { test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import { receiveAutomationWebhook, type AutomationWebhookBinding } from '../src/automation-webhooks';
const secret = 'synthetic-signing-secret-only';
const owner = { kind: 'bot' as const, id: crypto.randomUUID() };
const binding: AutomationWebhookBinding = { id: 'fixture', owner, source: 'slack', secretEnv: 'OPENTEAM_EVENT_FIXTURE', teamId: 'T1234', selfUserId: 'U1234', channelNames: { C1234: 'engineering' } };
const now = Date.now();
const slack = (body: unknown, timestamp = String(Math.floor(now / 1000))) => { const raw = JSON.stringify(body); return new Request('http://localhost/fixture', { method: 'POST', body: raw, headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}` } }); };
test('signed Slack challenges and deliveries enforce age, workspace and fixed owner', async () => {
 const calls: unknown[] = []; const dispatch = async (...args: unknown[]) => { calls.push(args); };
 const challenge = await receiveAutomationWebhook(slack({ type: 'url_verification', challenge: 'fixture' }), binding, secret, dispatch, now);
 expect(await challenge.json()).toEqual({ challenge: 'fixture' }); expect(calls).toHaveLength(0);
 const payload = { event_id: 'Ev123', team_id: 'T1234', event: { type: 'app_mention', channel: 'C1234', text: 'Hello <@U1234>', user: 'U5678' } };
 await receiveAutomationWebhook(slack(payload), binding, secret, dispatch, now);
 expect(calls).toEqual([[owner, expect.objectContaining({ source: 'slack', id: 'Ev123', channel: 'engineering', mention: true, bySelf: false })]]);
 await expect(receiveAutomationWebhook(slack(payload, '1'), binding, secret, dispatch, now)).rejects.toThrow('Expired');
 await expect(receiveAutomationWebhook(slack({ ...payload, team_id: 'OTHER' }), binding, secret, dispatch, now)).rejects.toThrow('workspace');
 const altered = slack(payload); altered.headers.set('x-slack-signature', 'v0=bad'); await expect(receiveAutomationWebhook(altered, binding, secret, dispatch, now)).rejects.toThrow('signature'); expect(calls).toHaveLength(1);
});
test('GitHub signed delivery maps PR and CI events and rejects repository substitution', async () => {
 const calls: any[] = []; const git = { ...binding, source: 'github' as const, repository: 'fixture/repo' };
 const request = (payload: unknown, type: string) => { const raw = JSON.stringify(payload); return new Request('http://localhost/fixture', { method: 'POST', body: raw, headers: { 'x-github-event': type, 'x-github-delivery': 'delivery-123', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } }); };
 const payload = { repository: { full_name: 'fixture/repo' }, sender: { login: 'alice' }, action: 'closed', pull_request: { number: 9, merged: true, head: { ref: 'main' } } };
 await receiveAutomationWebhook(request(payload, 'pull_request'), git, secret, async (_owner, event) => { calls.push(event); });
 expect(calls[0]).toMatchObject({ kind: 'pr-merged', pr: 9, actor: 'alice', repo: 'fixture/repo' });
 await expect(receiveAutomationWebhook(request({ ...payload, repository: { full_name: 'attacker/repo' } }, 'pull_request'), git, secret, async () => {})).rejects.toThrow('repository');
 await receiveAutomationWebhook(request({ ...payload, pull_request: undefined, action: 'completed', check_suite: { conclusion: 'failure', head_branch: 'main', pull_requests: [{ number: 9 }] } }, 'check_suite'), git, secret, async (_owner, event) => { calls.push(event); });
 expect(calls[1]).toMatchObject({ kind: 'ci-failed', branch: 'main', pr: 9 });
});
