import { GoogleApi, integer, segment, servePlugin, string, strings, type Args, type Tool } from '../../_shared/google';
import { base64Bytes, compact, mapConcurrent, referenceTool } from '../../_shared/reference';
import { extractContent } from './extract';
import { driveQuery } from './query';

const fields = 'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,parents,description,owners(emailAddress),sharedWithMeTime,viewedByMeTime,fileExtension,capabilities(canAddChildren)';
const normalizeFile = (f: any) => compact({ ...f, title: f.name, viewUrl: f.webViewLink, resourceUri: f.id ? `gdrive:///${f.id}` : undefined, fileSize: f.size, owner: f.owners?.[0]?.emailAddress, parentId: f.parents?.[0], canAddChildren: f.capabilities?.canAddChildren });
const exportFormats: Record<string, string> = { 'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const downloadFormats: Record<string, string> = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' };
const maxFileBytes = 64 * 1024 * 1024;

export function driveTools(api = new GoogleApi('https://www.googleapis.com')): Tool[] {
  const ref = (name: string, run: Tool['run'], options: Parameters<typeof referenceTool>[3] = {}) => referenceTool('drive', name, run, options);
  const file = (id: string) => `/drive/v3/files/${segment(id)}`;
  const metadata = (id: string) => api.request(file(id), { fields, supportsAllDrives: true });
  const fetchContent = async (f: any, exportMimeType?: string, readable = true) => {
    if (Number(f.size) > maxFileBytes) throw new Error('File exceeds the 64 MB per-operation limit; use a smaller file or download it in Drive.');
    const native = f.mimeType?.startsWith('application/vnd.google-apps.');
    const mimeType = native ? exportMimeType ?? (readable ? exportFormats : downloadFormats)[f.mimeType] : f.mimeType;
    if (native && !mimeType) return { bytes: new Uint8Array(), mimeType: f.mimeType, unsupported: true };
    const response = await api.request(native ? `${file(f.id)}/export` : file(f.id), native ? { mimeType } : { alt: 'media', supportsAllDrives: true }, 'GET', undefined, { binary: true, maxBytes: maxFileBytes });
    return { bytes: new Uint8Array(Buffer.from(response.data, 'base64')), mimeType, unsupported: false };
  };
  const textContent = async (f: any, exportMimeType?: string) => {
    const content = await fetchContent(f, exportMimeType);
    return content.unsupported ? { text: '', supported: false, method: 'unsupported' } : extractContent(content.bytes, content.mimeType);
  };
  const withSnippet = async (f: any, a: Args) => {
    const result = normalizeFile(f);
    if (a.excludeContentSnippets) return result;
    try {
      const text = await textContent(f);
      const limit: number = ({ BRIEF: 1000, MEDIUM: 2500, DETAILED: 5000, MAX_ALLOWED: 20_000 } as Record<string, number>)[a.snippetVerbosity] ?? 5000;
      return { ...result, contentSnippet: text.text.slice(0, limit), ...(!text.supported ? { textFormattingNotSupported: true } : {}) };
    } catch (error) {
      // Discovery remains usable when one file is restricted, malformed, or cannot be exported.
      return { ...result, contentSnippetUnavailable: error instanceof Error ? error.message : 'Content unavailable' };
    }
  };
  const list = async (a: Args, q: string, orderBy?: string) => {
    const value = await api.request('/drive/v3/files', { q, orderBy, pageToken: a.pageToken, pageSize: a.pageSize ?? 10, spaces: 'drive', fields: `nextPageToken,incompleteSearch,files(${fields})`, supportsAllDrives: true, includeItemsFromAllDrives: true });
    return compact({ files: await mapConcurrent(value.files ?? [], (f: any) => withSnippet(f, a)), nextPageToken: value.nextPageToken, incompleteSearch: value.incompleteSearch });
  };
  const comments = async (id: string) => {
    const threads: any[] = [];
    let pageToken: string | undefined;
    do {
      const page = await api.request(`${file(id)}/comments`, { pageSize: 100, pageToken, includeDeleted: false, fields: 'nextPageToken,comments(id,content,author(displayName),modifiedTime,resolved,quotedFileContent,anchor,replies(id,content,author(displayName),modifiedTime,deleted))' });
      for (const c of page.comments ?? []) {
        const post = (p: any) => compact({ postId: p.id, authorName: p.author?.displayName, content: p.content, modifiedTime: p.modifiedTime });
        threads.push({ commentId: c.id, headPost: post(c), replies: (c.replies ?? []).filter((p: any) => !p.deleted).map(post), status: c.resolved ? 'RESOLVED' : 'OPEN', quotedContent: c.quotedFileContent?.value, anchor: c.anchor });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return threads;
  };
  return [
    ref('list_recent_files', a => list(a, 'trashed = false', ({ lastModified: 'modifiedTime desc', lastModifiedByMe: 'modifiedByMeTime desc' } as Record<string,string>)[a.orderBy] ?? 'recency desc')),
    ref('search_files', a => list(a, `trashed = false${a.q ? ` and (${a.q})` : a.query ? ` and (${driveQuery(a.query)})` : ''}`), { properties: { q: string('Legacy Drive v3 query; query accepts the published MCP query syntax or plain keywords') } }),
    ref('get_file_metadata', async a => withSnippet(await metadata(a.fileId), a)),
    ref('get_file_permissions', async a => {
      const permissions: any[] = [];
      let pageToken = a.pageToken;
      do {
        const p = await api.request(`${file(a.fileId)}/permissions`, { pageToken, pageSize: a.pageSize ?? 100, fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,view)', supportsAllDrives: true });
        permissions.push(...(p.permissions ?? [])); pageToken = p.nextPageToken;
        if (a.pageSize || a.pageToken) break;
      } while (pageToken);
      return compact({ permissions, nextPageToken: pageToken });
    }, { properties: { pageToken: string('Legacy pagination token'), pageSize: integer('Legacy page size', 100) } }),
    ref('read_file_content', async a => {
      const f = await metadata(a.fileId);
      const content = await textContent(f, a.exportMimeType);
      const supportsComments = f.mimeType in exportFormats;
      const threads = a.includeComments && supportsComments ? await comments(f.id) : [];
      let fileContent = content.text;
      for (const thread of threads) {
        const marker = `[comment:${thread.commentId}]`;
        if (thread.quotedContent && fileContent.includes(thread.quotedContent)) fileContent = fileContent.replace(thread.quotedContent, `${thread.quotedContent} ${marker}`);
        else fileContent += `\n${marker} ${thread.quotedContent ?? ''}`;
      }
      return compact({ fileContent, textFormattingNotSupported: !content.supported, ...(a.includeComments ? { commentThreads: threads, commentsNotSupported: !supportsComments } : {}), extractionMethod: content.method });
    }, { properties: { exportMimeType: string('Optional supported export MIME type') } }),
    ref('download_file_content', async a => {
      const f = await metadata(a.fileId);
      const content = await fetchContent(f, a.exportMimeType, false);
      if (content.unsupported) throw new Error('This file type requires a supported exportMimeType');
      return { id: f.id, title: f.name, mimeType: content.mimeType, content: Buffer.from(content.bytes).toString('base64') };
    }),
    ref('copy_file', async a => {
      const name = a.title ?? a.name ?? `Copy of ${(await metadata(a.fileId)).name}`;
      return normalizeFile(await api.request(`${file(a.fileId)}/copy`, { fields, supportsAllDrives: true }, 'POST', compact({ name, parents: a.parentId ? [a.parentId] : a.parents })));
    }, { risk: 'write', properties: { name: string('Legacy title'), parents: strings('Legacy destination folder IDs') } }),
    ref('create_file', async a => {
      const legacy = a.name !== undefined && a.title === undefined;
      const contentKeys = ['base64Content','textContent','content'].filter(k => a[k] !== undefined);
      if (contentKeys.length > 1) throw new Error('Supply only one of base64Content, textContent or content');
      const inputMime = a.contentMimeType ?? a.mimeType ?? (legacy ? 'text/plain' : undefined);
      if (contentKeys.length && !inputMime) throw new Error('contentMimeType is required when uploading content');
      if (inputMime && !/^[\w.+-]+\/[\w.+-]+$/.test(inputMime)) throw new Error('Invalid contentMimeType');
      let mimeType = inputMime;
      if (!legacy && !a.disableConversionToGoogleType && inputMime && !inputMime.startsWith('application/vnd.google-apps.')) {
        if (/spreadsheet|excel|csv|opendocument.spreadsheet/.test(inputMime)) mimeType = 'application/vnd.google-apps.spreadsheet';
        else if (/presentation|powerpoint/.test(inputMime)) mimeType = 'application/vnd.google-apps.presentation';
        else if (/^text\/(plain|html)$|word|opendocument.text|rtf/.test(inputMime)) mimeType = 'application/vnd.google-apps.document';
      }
      const meta = compact({ name: a.title ?? a.name, mimeType, parents: a.parentId ? [a.parentId] : a.parents });
      if (!meta.name?.trim()) throw new Error('A file title is required');
      if (contentKeys.length && mimeType === 'application/vnd.google-apps.folder') throw new Error('Folders cannot contain uploaded file content');
      if (!contentKeys.length || mimeType === 'application/vnd.google-apps.folder') return normalizeFile(await api.request('/drive/v3/files', { fields, supportsAllDrives: true }, 'POST', meta));
      const bytes = a.base64Content !== undefined ? base64Bytes(a.base64Content) : a.textContent !== undefined ? Buffer.from(a.textContent) : legacy ? Buffer.from(a.content) : base64Bytes(a.content);
      if (bytes.length > maxFileBytes) throw new Error('Uploads are limited to 64 MB per operation');
      const contentMime = inputMime?.startsWith('application/vnd.google-apps.') ? 'text/plain' : inputMime!;
      if (bytes.length > 5 * 1024 * 1024) {
        const session = await api.request('/upload/drive/v3/files', { uploadType: 'resumable', fields, supportsAllDrives: true }, 'POST', meta, { includeHeaders: true, headers: { 'X-Upload-Content-Type': contentMime, 'X-Upload-Content-Length': String(bytes.length) } });
        const target = new URL(session.headers.location);
        if (target.origin !== 'https://www.googleapis.com' || !target.pathname.startsWith('/upload/drive/v3/files')) throw new Error('Google returned an unexpected upload URL');
        return normalizeFile(await api.request(target.pathname + target.search, {}, 'PUT', undefined, { rawBody: bytes, contentType: contentMime }));
      }
      const boundary = `openteam-${crypto.randomUUID()}`;
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${contentMime}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      return normalizeFile(await api.request('/upload/drive/v3/files', { uploadType: 'multipart', fields, supportsAllDrives: true }, 'POST', undefined, { rawBody: body, contentType: `multipart/related; boundary=${boundary}` }));
    }, { risk: 'write', properties: { name: string('Legacy file title'), parents: strings('Legacy destination folder IDs') }, required: [], anyOf: [{ required: ['title'] }, { required: ['name'] }] }),
  ];
}
if (import.meta.main) await servePlugin('openteam-google-drive', driveTools());
