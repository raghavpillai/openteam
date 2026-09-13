import { GoogleApi, page, segment, servePlugin, string, tool, type Args, type Tool } from '../../_shared/google';
import { compact, mapConcurrent, referenceTool, referenceTools } from '../../_shared/reference';
import { draftMime, normalizeMessage } from './messages';

const visibility: Record<string, string> = { LABEL_SHOW: 'labelShow', LABEL_SHOW_IF_UNREAD: 'labelShowIfUnread', LABEL_HIDE: 'labelHide', SHOW: 'show', HIDE: 'hide' };
const colorSchema: any = referenceTools.gmail.find(t => t.name === 'create_label')!.inputSchema.properties.colorPreset;
const colors: Record<string, any> = Object.fromEntries(colorSchema.enum.slice(1).map((key: string, i: number) => {
  const hex = colorSchema['x-google-enum-descriptions'][i + 1].match(/#[0-9a-f]{6}/g);
  return [key, { backgroundColor: hex[0], textColor: hex[1] }];
}));
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
      return compact({ threads: await mapConcurrent(t.threads ?? [], (t: any) => thread(t.id, a.view === 'THREAD_VIEW_METADATA_ONLY' ? 'METADATA_ONLY' : 'MINIMAL')), nextPageToken: t.nextPageToken });
    }, { properties: { maxResults: page.maxResults } }),
    ref('get_message', a => message(a.messageId, a.messageFormat)),
    ref('get_thread', a => thread(a.threadId, a.messageFormat)),
    ref('get_draft', a => draft(a.draftId, a.messageFormat)),
    ref('list_drafts', async a => {
      const d = await api.request('/drafts', { q: a.query, pageToken: a.pageToken, maxResults: a.pageSize ?? a.maxResults ?? 20 });
      return compact({ drafts: await mapConcurrent(d.drafts ?? [], (d: any) => draft(d.id, a.view === 'DRAFT_VIEW_FULL' ? 'FULL_CONTENT' : 'METADATA_ONLY')), nextPageToken: d.nextPageToken });
    }, { properties: { maxResults: page.maxResults } }),
    ref('create_draft', async a => {
      const original = a.replyToMessageId ? await hydrate(await api.request(`/messages/${segment(a.replyToMessageId)}`, { format: 'full' })) : undefined;
      const mime = draftMime(a, original);
      const d = await api.request('/drafts', {}, 'POST', { message: compact(mime) });
      // The insert result is authoritative; a subsequent read must not make a successful write appear failed.
      return compact({ id: d.id, messageId: d.message?.id, threadId: d.message?.threadId ?? mime.threadId });
    }, { risk: 'write', properties: { threadId: string('Legacy thread ID; use replyToMessageId for a correctly threaded reply') } }),
    ref('update_message_labels', a => api.request(`/messages/${segment(a.messageId)}/modify`, {}, 'POST', { addLabelIds: a.addLabelIds ?? [], removeLabelIds: a.removeLabelIds ?? [] }), { risk: 'write' }),
  ];
  for (const kind of ['message', 'thread'] as const) {
    const field = `${kind}Id`;
    const path = (a: Args) => `/${kind === 'message' ? 'messages' : 'threads'}/${segment(a[field])}`;
    for (const remove of [false, true]) tools.push(ref(`${remove ? 'unlabel' : 'label'}_${kind}`, a => api.request(`${path(a)}/modify`, {}, 'POST', { [remove ? 'removeLabelIds' : 'addLabelIds']: a.labelIds }), { risk: 'write' }));
    tools.push(ref(`apply_sensitive_${kind}_label`, a => {
      const label = a.labelOption ?? a.labelId;
      if (!['TRASH', 'SPAM'].includes(label)) throw new Error('Choose TRASH or SPAM');
      return label === 'TRASH' ? api.request(`${path(a)}/trash`, {}, 'POST', {}) : api.request(`${path(a)}/modify`, {}, 'POST', { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });
    }, { risk: 'destructive', properties: { labelId: string('Compatibility alias for labelOption', { enum: ['TRASH', 'SPAM'] }) }, required: [field], anyOf: [{ required: ['labelOption'] }, { required: ['labelId'] }] }));
    for (const undo of [false, true]) {
      tools.push(ref(`${undo ? 'untrash' : 'trash'}_${kind}`, a => api.request(`${path(a)}/${undo ? 'untrash' : 'trash'}`, {}, 'POST', {}), { risk: undo ? 'write' : 'destructive' }));
      tools.push(ref(`${undo ? 'unmark' : 'mark'}_${kind}_spam`, a => api.request(`${path(a)}/modify`, {}, 'POST', { addLabelIds: undo ? ['INBOX'] : ['SPAM'], removeLabelIds: undo ? ['SPAM'] : ['INBOX'] }), { risk: undo ? 'write' : 'destructive' }));
    }
  }
  return tools;
}
if (import.meta.main) await servePlugin('openteam-gmail', gmailTools());
