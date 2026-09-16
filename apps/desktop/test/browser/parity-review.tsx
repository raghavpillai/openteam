import React from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../../src/renderer/client/openteam-api';
import { UserFormCard } from '../../src/renderer/components/openteam/user-form-card';
import { ExternalDraftCard } from '../../src/renderer/components/openteam/external-draft-card';
import { ReviewActionCard } from '../../src/renderer/components/openteam/review-action-card';
import type { ChannelMessageView, UserForm, ExternalDraft } from '@openteam/contracts';
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const base = (id: string, metadata: unknown) => ({ id, content: '', metadata }) as ChannelMessageView;
const form: UserForm = { title: 'Sign in to Example', instruction: 'Fill your email and password on the open page.', domain: 'example.com', fields: [{ id: 'email', label: 'Email', type: 'email', required: true }, { id: 'password', label: 'Password', type: 'password', required: true }] };
const draft: ExternalDraft = { platform: 'email', providerIdentifier: 'fixture-account', from: 'author@example.com', to: ['recipient@example.com'], subject: 'Review the research', body: 'Here are the sources we discussed.' };
const recipe = { profile: { name: 'Research partner', description: 'A reusable workflow for comparing primary sources.' }, memory: [], skills: [{ name: 'Research', content: 'Collect and compare sources.' }], routines: [], plugins: [], visibility: 'team' };
const fm = base('form', { type: 'user-form', cardState: 'pending' }); const dm = base('draft', { type: 'external-draft', cardState: 'pending', draft: { ...draft, verification: { identity: draft.from } } }); const tm = base('template', { type: 'review-action', cardState: 'pending', review: { kind: 'template', recipe, version: 1 } });
const delivered: any[] = [], reviews: string[] = []; let release: (() => void) | undefined;
api.userFormPrefill = async () => ({ email: 'prefilled@example.com' });
api.submitUserForm = (async (_id: string, values: unknown, save: boolean) => { delivered.push({ kind: 'form', values, save }); await new Promise<void>((resolve) => { release = resolve; }); return { message: base('form', { cardState: 'submitted' }) }; }) as any;
api.mutateExternalDraft = (async (_id: string, action: string, edits: unknown) => { delivered.push({ kind: 'draft', action, edits }); return { message: base('draft', { cardState: action === 'send' ? 'sent' : 'pending' }) }; }) as any;
api.mutateReviewAction = (async (_id: string, action: string) => { reviews.push(action); return { message: base('template', { cardState: action === 'unpublish' ? 'unpublished' : 'published' }), ...(action === 'import' ? { botId: 'new-fixture' } : {}) }; }) as any;
api.reviewRecipe = async () => recipe as never;
const root = createRoot(document.getElementById('root')!);
function Cards() { return <><h1>Review before continuing</h1><main><section id="form"><UserFormCard message={fm} form={form} /></section><section id="draft"><ExternalDraftCard message={dm} draft={draft} /></section><section id="template"><ReviewActionCard message={tm} /></section></main></>; }
root.render(<React.StrictMode><Cards /></React.StrictMode>);
const button = (scope: string, text: string) => [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((node) => node.textContent === text)!;
function setValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) { const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }
(async () => {
 await wait(180);
 assert(document.querySelector<HTMLInputElement>('#form input[type=email]')!.value === 'prefilled@example.com', 'nonsecret prefill');
 assert(button('#form', 'Continue').disabled, 'required password blocks submission');
 setValue(document.querySelector<HTMLInputElement>('#form input[type=password]')!, 'fixture-secret'); await wait();
 assert(!document.body.textContent!.includes('fixture-secret'), 'password is masked');
 (window as any).parityReady = true; // Runner captures the initial real Chromium view.
 await wait(500);
 button('#form', 'Continue').click(); button('#form', 'Continue').click(); await wait();
 assert(delivered.filter((item) => item.kind === 'form').length === 1, 'one submission while pending');
 release!(); await wait(); assert(!document.querySelector('#form input'), 'values removed after submission');
 setValue(document.querySelector<HTMLTextAreaElement>('#draft textarea')!, 'Human reviewed body'); await wait(); button('#draft', 'Save').click(); await wait();
 assert(delivered.find((item) => item.action === 'save').edits.body === 'Human reviewed body', 'edited body saved');
 assert(!delivered.some((item) => item.action === 'send'), 'save does not send');
 button('#draft', 'Send').click(); await wait(); assert(delivered.filter((item) => item.action === 'send').length === 1, 'reviewed send once'); assert(document.querySelector('#draft')!.textContent!.includes('Message sent'), 'confirmed send state');
 button('#template', 'Publish').click(); await wait(); document.querySelector<HTMLButtonElement>('#template [aria-label="Template actions"]')!.click(); await wait(); [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((node) => node.textContent === 'Unpublish')!.click(); await wait();
 assert(!!button('#template', 'Publish'), 'revoked template can be republished'); button('#template', 'Publish').click(); await wait();
 button('#template', 'Use template').click(); await wait(); assert(reviews.join(',') === 'approve,unpublish,approve,import', 'template action lifecycle');
 assert(!JSON.stringify(localStorage).includes('fixture-secret'), 'values absent from local storage');
 (window as any).parityResults = { passed: 12, scenarios: ['form validation, prefill and value removal', 'duplicate submission protection', 'draft edit/save/send', 'template publish/revoke/republish/import'] };
})().catch((error) => { (window as any).parityResults = { error: String(error), stack: error.stack }; });
