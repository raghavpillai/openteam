import { GoogleApi, page, segment, servePlugin, string, tool, ToolNotes, type Args, type Tool } from '../../_shared/google';
import { compact, mapConcurrent, referenceTool, referenceTools } from '../../_shared/reference';
import { assertAttachmentsComplete, searchCoverageNote, unwrappedBody, withIdNote } from './guards';
import { draftMime, gmailDraftUrl, gmailViewUrl, headersOf, normalizeMessage, plainHtml } from './messages';

/** Matches the server's HOST_ONLY_TOOL_META: OpenTeam calls the tool, Bots never see it. */
const HOST_ONLY = { 'openteam/hostOnly': true };
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const visibility: Record<string, string> = { LABEL_SHOW: 'labelShow', LABEL_SHOW_IF_UNREAD: 'labelShowIfUnread', LABEL_HIDE: 'labelHide', SHOW: 'show', HIDE: 'hide' };
const colorSchema: any = referenceTools.gmail.find(t => t.name === 'create_label')!.inputSchema.properties.colorPreset;
const colors: Record<string, any> = Object.fromEntries(colorSchema.enum.slice(1).map((key: string, i: number) => {
  const hex = colorSchema['x-google-enum-descriptions'][i + 1].match(/#[0-9a-f]{6}/g);
  return [key, { backgroundColor: hex[0], textColor: hex[1] }];
}));
/** Google's search_threads shows a thread's newest messages only; get_thread has them all. */
const SEARCH_THREAD_MESSAGES = 5;
const filled = (value: unknown) => (Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0);
const normalizeLabel = (label: any) => compact({ ...label, labelId: label.id, labelType: label.type?.toUpperCase(),
  colorPreset: Object.entries(colors).find(([, c]) => c.backgroundColor === label.color?.backgroundColor && c.textColor === label.color?.textColor)?.[0] ?? 'LABEL_COLOR_PRESET_UNSPECIFIED',
  labelListVisibility: Object.keys(visibility).find(k => visibility[k] === label.labelListVisibility),
  messageListVisibility: Object.keys(visibility).find(k => visibility[k] === label.messageListVisibility),
});

export function gmailTools(api = new GoogleApi('https://gmail.googleapis.com/gmail/v1/users/me')): Tool[] {
  const ref = (name: string, run: Tool['run'], options: Parameters<typeof referenceTool>[3] = {}) => referenceTool('gmail', name, run, options);
  const hydrate = async (message: any) => {
    const visit = async (part: any): Promise<void> => {
      if (!part.filename && part.body?.attachmentId && /^text\//.test(part.mimeType ?? '')) {
        const body = await api.request(`/messages/${segment(message.id)}/attachments/${segment(part.body.attachmentId)}`);
        part.body = { ...part.body, data: body.data };
      }
      await mapConcurrent(part.parts ?? [], visit);
    };
    if (message.payload) await visit(message.payload);
    return message;
  };
  let viewer: Promise<string | undefined> | undefined;
  /** The signed-in address Gmail web links name; looked up once, again after a failure. */
  const account = () => viewer ??= api.request('/profile').then(
    (profile: any) => typeof profile.emailAddress === 'string' ? profile.emailAddress : undefined,
    () => { viewer = undefined; return undefined; });
  const linked = (message: any, as: string | undefined) => compact({ ...message, viewUrl: gmailViewUrl(as, message.threadId, message.id) });
  const message = async (id: string, format = 'FULL_CONTENT') => {
    const m = normalizeMessage(await hydrate(await api.request(`/messages/${segment(id)}`, { format: format === 'RAW' ? 'raw' : 'full' })), format);
    return format === 'RAW' ? m : linked(m, await account());
  };
  const thread = async (id: string, format = 'FULL_CONTENT', options: { newest?: number; account?: Promise<string | undefined> } = {}) => {
    const t = await api.request(`/threads/${segment(id)}`, { format: 'full' });
    const messages = (t.messages ?? []).filter((m: any) => !m.labelIds?.includes('DRAFT'));
    const as = await (options.account ?? account());
    return compact({
      id: t.id, messageCount: messages.length,
      messages: await mapConcurrent(options.newest ? messages.slice(-options.newest) : messages, async (m: any) =>
        linked(normalizeMessage(['MINIMAL','METADATA_ONLY'].includes(format) ? m : await hydrate(m), format), as)),
      viewUrl: gmailViewUrl(as, t.id),
    });
  };
  const draft = async (id: string, format = 'FULL_CONTENT') => {
    const d = await api.request(`/drafts/${segment(id)}`, { format: format === 'RAW' ? 'raw' : 'full' });
    const m = normalizeMessage(await hydrate(d.message ?? {}), format);
    return compact({ ...m, id: d.id, messageId: d.message?.id, viewUrl: format === 'RAW' ? undefined : gmailDraftUrl(await account(), d.message?.threadId, d.id) });
  };
  /** A written draft as Google returns it; the link lookup can't fail the write. */
  const written = async (d: any, threadId?: string) => {
    const thread = d.message?.threadId ?? threadId;
    return compact({ id: d.id, messageId: d.message?.id, threadId: thread, viewUrl: gmailDraftUrl(await account(), thread, d.id) });
  };
  /** The signature Gmail web adds for the default send-as address. */
  const defaultSignature = async (): Promise<string | undefined> => {
    const aliases: any[] = (await api.request('/settings/sendAs')).sendAs ?? [];
    const signature = (aliases.find(alias => alias.isDefault) ?? aliases.find(alias => alias.isPrimary))?.signature;
    return typeof signature === 'string' && signature.trim() ? signature.slice(0, 20_000) : undefined;
  };
  const tools: Tool[] = [
    tool('get_profile', 'Identify the signed-in Gmail account and mailbox counts.', {}, [], () => api.request('/profile')),
    tool('search_messages', 'Search messages using Gmail syntax. Follow nextPageToken for more results.', { query: string('Gmail query'), ...page }, ['query'], a => api.request('/messages', { q: a.query, pageToken: a.pageToken, maxResults: a.maxResults ?? 25 })),
    ref('list_labels', async () => {
      const value = await api.request('/labels');
      return { labels: await mapConcurrent(value.labels ?? [], async (label: any) => normalizeLabel(await api.request(`/labels/${segment(label.id)}`))) };
    }),
    ref('create_label', async a => {
      const name: string = a.displayName ?? a.name;
      if (!name?.trim() || name.split('/').some(p => !p.trim())) throw new Error('A nonempty label name and nonempty hierarchy segments are required');
      const labels = name.includes('/') && a.autoCreateParentLabels !== false ? (await api.request('/labels')).labels ?? [] : [];
      const parents = name.split('/').slice(0, -1);
      let path = '';
      for (const part of a.autoCreateParentLabels === false ? [] : parents) {
        path = path ? `${path}/${part}` : part;
        if (!labels.some((l: any) => l.name === path)) {
          try { labels.push(await api.request('/labels', {}, 'POST', { name: path })); }
          catch (error) { if (!String(error).includes('409')) throw error; }
        }
      }
      const result = await api.request('/labels', {}, 'POST', compact({ name, color: colors[a.colorPreset] ?? a.color,
        labelListVisibility: visibility[a.labelListVisibility] ?? 'labelShow', messageListVisibility: visibility[a.messageListVisibility] ?? 'show' }));
      return normalizeLabel(result);
    }, { risk: 'write', properties: { name: string('Compatibility alias for displayName') }, required: [], anyOf: [{ required: ['displayName'] }, { required: ['name'] }] }),
    ref('search_threads', async a => {
      const query = a.query ?? '';
      const t = await api.request('/threads', { q: /\bin:(?:drafts?|anywhere)\b/i.test(query) ? query : `${query} -in:drafts`.trim(), includeSpamTrash: a.includeTrash ?? false, pageToken: a.pageToken, maxResults: a.pageSize ?? a.maxResults ?? 20 });
      const listed: any[] = t.threads ?? [];
      const as = listed.length ? account() : undefined;
      const format = a.view === 'THREAD_VIEW_METADATA_ONLY' ? 'METADATA_ONLY' : 'MINIMAL';
      // Google's result shape: an empty page is {}, and the estimate is a string.
      const value = compact({
        nextPageToken: t.nextPageToken || undefined,
        resultCountEstimate: t.resultSizeEstimate ? String(t.resultSizeEstimate) : undefined,
        threads: listed.length ? await mapConcurrent(listed, (t: any) => thread(t.id, format, { newest: SEARCH_THREAD_MESSAGES, account: as })) : undefined,
      });
      // One narrow empty search, or a lookup's first page, is not proof the mail is missing.
      const note = searchCoverageNote(a, value);
      return note ? new ToolNotes(value, [note]) : value;
    }, { properties: { maxResults: page.maxResults } }),
    ref('get_message', withIdNote('message', a => message(a.messageId, a.messageFormat))),
    ref('get_thread', withIdNote('thread', a => thread(a.threadId, a.messageFormat))),
    ref('get_draft', withIdNote('draft', a => draft(a.draftId, a.messageFormat))),
    ref('list_drafts', async a => {
      const d = await api.request('/drafts', { q: a.query, pageToken: a.pageToken, maxResults: a.pageSize ?? a.maxResults ?? 20 });
      return compact({ drafts: d.drafts?.length ? await mapConcurrent(d.drafts, (d: any) => draft(d.id, a.view === 'DRAFT_VIEW_FULL' ? 'FULL_CONTENT' : 'METADATA_ONLY')) : undefined, nextPageToken: d.nextPageToken || undefined });
    }, { properties: { maxResults: page.maxResults } }),
    ref('create_draft', async input => {
      // Before the quoted reply is appended, like the reference's mailbox body unwrap.
      let a = unwrappedBody(input);
      assertAttachmentsComplete(a.attachments);
      if (a.includeSignature === true) {
        const signature = await defaultSignature();
        if (signature) a = { ...a,
          ...(typeof a.body === 'string' || a.htmlBody === undefined ? { body: `${a.body ?? ''}\n\n${plainHtml(signature)}` } : {}),
          ...(typeof a.htmlBody === 'string' ? { htmlBody: `${a.htmlBody}<br><div dir="ltr" class="gmail_signature">${signature}</div>` } : {}) };
      }
      const original = a.replyToMessageId ? await hydrate(await api.request(`/messages/${segment(a.replyToMessageId)}`, { format: 'full' })) : undefined;
      const mime = draftMime(a, original);
      const d = await api.request('/drafts', {}, 'POST', { message: compact(mime) });
      // The insert result is authoritative; a subsequent read must not make a successful write appear failed.
      return written(d, mime.threadId);
    }, { risk: 'write', properties: { threadId: string('Legacy thread ID; use replyToMessageId for a correctly threaded reply') } }),
    ref('update_draft', withIdNote('draft', async input => {
      const a = unwrappedBody(input);
      assertAttachmentsComplete(a.attachments);
      const current = await api.request(`/drafts/${segment(a.draftId)}`, { format: 'full' });
      const saved = await hydrate(current.message ?? {});
      const h = headersOf(saved), existing = normalizeMessage(saved);
      const sender = h.from?.match(/^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/);
      const mime = draftMime({
        from: sender?.[2] ?? (h.from?.includes('@') ? h.from.trim() : undefined), fromName: sender?.[1]?.trim() || undefined,
        to: filled(a.to) ? a.to : existing.toRecipients, cc: filled(a.cc) ? a.cc : existing.ccRecipients, bcc: filled(a.bcc) ? a.bcc : existing.bccRecipients,
        subject: filled(a.subject) ? a.subject : h.subject ?? '',
        body: filled(a.body) ? a.body : filled(a.htmlBody) ? undefined : existing.plaintextBody,
        htmlBody: filled(a.htmlBody) ? a.htmlBody : filled(a.body) ? undefined : existing.htmlBody,
        attachments: a.attachments, inReplyTo: h['in-reply-to'], references: h.references, threadId: saved.threadId,
      });
      const d = await api.request(`/drafts/${segment(a.draftId)}`, {}, 'PUT', { id: a.draftId, message: compact(mime) });
      return written(d, mime.threadId);
    }), { risk: 'write' }),
    ref('delete_draft', withIdNote('draft', a => api.request(`/drafts/${segment(a.draftId)}`, {}, 'DELETE')), { risk: 'destructive' }),
    ref('update_message_labels', withIdNote('message', a => api.request(`/messages/${segment(a.messageId)}/modify`, {}, 'POST', { addLabelIds: a.addLabelIds ?? [], removeLabelIds: a.removeLabelIds ?? [] })), { risk: 'write' }),
  ];
  // Card review: OpenTeam verifies the route when a Bot drafts, then sends only after the user presses Send.
  const sendingAs = async (from: string) => {
    const [profile, aliases] = await Promise.all([api.request('/profile'), api.request('/settings/sendAs')]);
    const account = String(profile.emailAddress ?? '').toLowerCase();
    const addresses: any[] = (aliases.sendAs ?? []).filter((alias: any) => alias.isPrimary || alias.verificationStatus === 'accepted');
    const alias = addresses.find(entry => String(entry.sendAsEmail).toLowerCase() === from.toLowerCase());
    if (!account || !alias) throw new Error(`This Gmail account (${account || 'unknown'}) can't send as ${from}. Add the address under Gmail settings, Accounts, Send mail as.`);
    return { account, addresses, alias };
  };
  const recipients = { type: 'array', items: { type: 'string' }, maxItems: 100 };
  tools.push({ ...tool('send_reviewed_email', 'OpenTeam calls this to verify a DraftExternalMessage card and, after the user presses Send, to send it from this Gmail account.', {
    action: string('verify checks the route; send delivers it', { enum: ['verify', 'send'] }),
    draft: { type: 'object', description: 'The reviewed draft', properties: { from: { type: 'string' }, to: recipients, cc: recipients, subject: { type: 'string' }, body: { type: 'string' }, html: { type: 'string' }, signatureHtml: { type: 'string' }, replyToMessageId: { type: 'string' } }, required: ['from', 'to', 'subject', 'body'], additionalProperties: false },
  }, ['action', 'draft'], async ({ action, draft }) => {
    const { account, addresses, alias } = await sendingAs(String(draft.from));
    if (action === 'verify') {
      let thread: string | undefined, threadUrl: string | undefined;
      if (draft.replyToMessageId) {
        const original = await api.request(`/messages/${segment(draft.replyToMessageId)}`, { format: 'metadata', metadataHeaders: ['Subject', 'From'] });
        const h = headersOf(original);
        const sender = h.from?.replace(/^<([^<>]+)>$/, '$1');
        thread = h.subject ? `“${h.subject}”${sender ? ` from ${sender}` : ''}` : `message ${draft.replyToMessageId}`;
        threadUrl = `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#all/${encodeURIComponent(original.threadId ?? draft.replyToMessageId)}`;
      }
      return compact({
        identity: account,
        sendingAddresses: addresses.map(entry => String(entry.sendAsEmail).toLowerCase()),
        signatures: Object.fromEntries(addresses.filter(entry => entry.signature?.trim()).map(entry => [String(entry.sendAsEmail).toLowerCase(), entry.signature])),
        thread, threadUrl,
      });
    }
    const original = draft.replyToMessageId ? await hydrate(await api.request(`/messages/${segment(draft.replyToMessageId)}`, { format: 'full' })) : undefined;
    // The signature the card showed goes out under the body, above any quoted reply.
    const signature = typeof draft.signatureHtml === 'string' && draft.signatureHtml.trim() ? draft.signatureHtml : undefined;
    const html = draft.html ?? `<div dir="auto">${escapeHtml(draft.body).replaceAll('\n', '<br>')}</div>`;
    const mime = draftMime({
      // Without a From header Gmail sends as the primary address under the account's own name.
      from: alias.isPrimary && !alias.displayName ? undefined : alias.sendAsEmail, fromName: alias.displayName || undefined, to: draft.to, cc: draft.cc, subject: draft.subject,
      body: signature ? `${draft.body}\n\n${plainHtml(signature)}` : draft.body,
      htmlBody: signature ? `${html}<br><div dir="ltr" class="gmail_signature">${signature}</div>` : html,
    }, original);
    const sent = await api.request('/messages/send', {}, 'POST', compact(mime));
    return compact({ id: sent.id, threadId: sent.threadId, labelIds: sent.labelIds });
  }, 'write'), _meta: HOST_ONLY });
  for (const kind of ['message', 'thread'] as const) {
    const field = `${kind}Id`;
    const path = (a: Args) => `/${kind === 'message' ? 'messages' : 'threads'}/${segment(a[field])}`;
    for (const remove of [false, true]) tools.push(ref(`${remove ? 'unlabel' : 'label'}_${kind}`, withIdNote(kind, a => api.request(`${path(a)}/modify`, {}, 'POST', { [remove ? 'removeLabelIds' : 'addLabelIds']: a.labelIds })), { risk: 'write' }));
    tools.push(ref(`apply_sensitive_${kind}_label`, withIdNote(kind, a => {
      const label = a.labelOption ?? a.labelId;
      if (!['TRASH', 'SPAM'].includes(label)) throw new Error('Choose TRASH or SPAM');
      return label === 'TRASH' ? api.request(`${path(a)}/trash`, {}, 'POST', {}) : api.request(`${path(a)}/modify`, {}, 'POST', { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });
    }), { risk: 'destructive', properties: { labelId: string('Compatibility alias for labelOption', { enum: ['TRASH', 'SPAM'] }) }, required: [field], anyOf: [{ required: ['labelOption'] }, { required: ['labelId'] }] }));
    for (const undo of [false, true]) {
      tools.push(ref(`${undo ? 'untrash' : 'trash'}_${kind}`, withIdNote(kind, a => api.request(`${path(a)}/${undo ? 'untrash' : 'trash'}`, {}, 'POST', {})), { risk: undo ? 'write' : 'destructive' }));
      tools.push(ref(`${undo ? 'unmark' : 'mark'}_${kind}_spam`, withIdNote(kind, a => api.request(`${path(a)}/modify`, {}, 'POST', { addLabelIds: undo ? ['INBOX'] : ['SPAM'], removeLabelIds: undo ? ['SPAM'] : ['INBOX'] })), { risk: undo ? 'write' : 'destructive' }));
    }
  }
  return tools;
}
if (import.meta.main) await servePlugin('openteam-gmail', gmailTools());
