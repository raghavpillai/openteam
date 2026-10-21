import { GoogleApi, page, segment, servePlugin, string, tool, ToolNotes, type Args, type Tool } from '../../_shared/google';
import { compact, mapConcurrent, referenceTool, referenceTools } from '../../_shared/reference';
import { assertAttachmentsComplete, searchCoverageNote, unwrappedBody, withIdNote } from './guards';
import { draftMime, headersOf, normalizeMessage, plainHtml } from './messages';

/** Matches the server's HOST_ONLY_TOOL_META: OpenTeam calls the tool, Bots never see it. */
const HOST_ONLY = { 'openteam/hostOnly': true };
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const visibility: Record<string, string> = { LABEL_SHOW: 'labelShow', LABEL_SHOW_IF_UNREAD: 'labelShowIfUnread', LABEL_HIDE: 'labelHide', SHOW: 'show', HIDE: 'hide' };
const colorSchema: any = referenceTools.gmail.find(t => t.name === 'create_label')!.inputSchema.properties.colorPreset;
const colors: Record<string, any> = Object.fromEntries(colorSchema.enum.slice(1).map((key: string, i: number) => {
  const hex = colorSchema['x-google-enum-descriptions'][i + 1].match(/#[0-9a-f]{6}/g);
  return [key, { backgroundColor: hex[0], textColor: hex[1] }];
}));
// Google's current texts where the 2026-09-12 pin is wrong or silent and the REST implementation
// behaves as Google now describes. Throws when a refreshed pin no longer holds the old text.
const revised = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`Gmail reference text changed: ${from}`);
  return text.replace(from, to);
};
const reference = (name: string) => referenceTools.gmail.find(t => t.name === name)! as any;
const searchThreads = reference('search_threads');
const createDraft = reference('create_draft');
const searchThreadsText = {
  description: revised(searchThreads.description, "\n\nNote: An empty JSON object",
    "\n\nTo list threads in a specific inbox category tab, use the `category:` operator with `primary`, `social`, `promotions`, `updates`, or `forums` (e.g. `in:inbox category:promotions`).\n\nNote: An empty JSON object"),
  query: { ...searchThreads.inputSchema.properties.query, description: revised(searchThreads.inputSchema.properties.query.description,
    "`label:` — Under a specific label. The tool accepts label IDs, not display names. Use the `list_labels` tool to get the ID.",
    "`label:` — Under a specific label, matched by its display name (the `name` from `list_labels`), for example `label:wins`. Label IDs such as `Label_123` match nothing. Quote a name that contains spaces (`label:\"Board Prep\"`) or replace its spaces and `/` with `-` (`label:board-prep`).") },
};
const createDraftText = {
  description: revised(revised(createDraft.description,
    "Plain text body content can be provided in `body`, and rich-text HTML content can be provided in `htmlBody` (if both are provided,",
    "Plain text body content can be provided in `body` (do NOT format `body` with Markdown), and rich-text HTML content can be provided in `htmlBody` (use valid HTML tags for formatting; if both are provided,"),
    "the `replyToMessageId` field.\n",
    "the `replyToMessageId` field. Set `includeSignature` to true to append the user's configured Gmail web signature to the draft.\n"),
  body: { ...createDraft.inputSchema.properties.body, description: revised(createDraft.inputSchema.properties.body.description,
    "Optional. The main body content of the email draft.",
    "Optional. The plain text body content of the email draft. Do NOT format this field with Markdown (such as headers `#`, bold `**`, bullet points `*`, or tables `|`). If formatted rich text is desired, use `html_body` instead.") },
  includeSignature: { type: 'boolean', description: "Optional. Whether to append the user's configured Gmail web signature to the draft. Defaults to false." },
};
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
  const message = async (id: string, format = 'FULL_CONTENT') => normalizeMessage(await hydrate(await api.request(`/messages/${segment(id)}`, { format: format === 'RAW' ? 'raw' : 'full' })), format);
  const thread = async (id: string, format = 'FULL_CONTENT') => {
    if (format === 'RAW') throw new Error('RAW format is only available for individual messages or drafts');
    const t = await api.request(`/threads/${segment(id)}`, { format: 'full' });
    const messages = (t.messages ?? []).filter((m: any) => !m.labelIds?.includes('DRAFT'));
    return { id: t.id, messages: await mapConcurrent(messages, async (m: any) => normalizeMessage(['MINIMAL','METADATA_ONLY'].includes(format) ? m : await hydrate(m), format)) };
  };
  const draft = async (id: string, format = 'FULL_CONTENT') => {
    const d = await api.request(`/drafts/${segment(id)}`, { format: format === 'RAW' ? 'raw' : 'full' });
    return { ...normalizeMessage(await hydrate(d.message ?? {}), format), id: d.id, messageId: d.message?.id };
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
      const value = compact({ threads: await mapConcurrent(t.threads ?? [], (t: any) => thread(t.id, a.view === 'THREAD_VIEW_METADATA_ONLY' ? 'METADATA_ONLY' : 'MINIMAL')), nextPageToken: t.nextPageToken });
      // One narrow empty search, or a lookup's first page, is not proof the mail is missing.
      const note = searchCoverageNote(a, value);
      return note ? new ToolNotes(value, [note]) : value;
    }, { description: searchThreadsText.description, properties: { query: searchThreadsText.query, maxResults: page.maxResults } }),
    ref('get_message', withIdNote('message', a => message(a.messageId, a.messageFormat))),
    ref('get_thread', withIdNote('thread', a => thread(a.threadId, a.messageFormat))),
    ref('get_draft', withIdNote('draft', a => draft(a.draftId, a.messageFormat))),
    ref('list_drafts', async a => {
      const d = await api.request('/drafts', { q: a.query, pageToken: a.pageToken, maxResults: a.pageSize ?? a.maxResults ?? 20 });
      return compact({ drafts: await mapConcurrent(d.drafts ?? [], (d: any) => draft(d.id, a.view === 'DRAFT_VIEW_FULL' ? 'FULL_CONTENT' : 'METADATA_ONLY')), nextPageToken: d.nextPageToken });
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
      return compact({ id: d.id, messageId: d.message?.id, threadId: d.message?.threadId ?? mime.threadId });
    }, { risk: 'write', description: createDraftText.description, properties: { body: createDraftText.body, includeSignature: createDraftText.includeSignature, threadId: string('Legacy thread ID; use replyToMessageId for a correctly threaded reply') } }),
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
