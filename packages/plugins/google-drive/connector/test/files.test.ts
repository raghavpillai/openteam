import { expect, test } from 'bun:test';
import { utils, write } from 'xlsx';
import { createToolValidator } from '@openteam/plugin-sdk/json-schema';
import { referenceTools } from '../../../_shared/reference';
import { driveTools } from '../server';
import { lineRange as range } from '../content';
import { searchQuery } from '../query';
import { harness } from '../../../test/parity-harness';

const doc='application/vnd.google-apps.document', sheet='application/vnd.google-apps.spreadsheet', slides='application/vnd.google-apps.presentation', drawing='application/vnd.google-apps.drawing', folder='application/vnd.google-apps.folder';
const xlsx=()=>{const book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet([['Name','Amount'],['Alpha',12]]),'Budget');utils.book_append_sheet(book,utils.aoa_to_sheet([['Next'],['Ship']]),'Actions');return new Uint8Array(write(book,{type:'buffer',bookType:'xlsx'}) as Buffer);};
const lineRange=(text:string,a:Parameters<typeof range>[1]):Record<string,unknown>=>range(text,a);
const multipart=(bytes:Buffer)=>{const [,head,body]=bytes.toString().split('\r\n\r\n');return {meta:JSON.parse(head!.split('\r\n')[0]!),contentType:head!.split('Content-Type: ')[1],body:body!.split('\r\n--')[0]};};
const denied=()=>Response.json({error:{message:'The user has not granted the app 123 write access to the file f.'}},{status:403});

test('Drive serves the pinned file tools with their exact definitions plus the earlier Google tools', () => {
  const tools=driveTools(), references=referenceTools.driveFiles;
  expect(tools.map(t=>t.name).sort()).toEqual([...references.map(r=>r.name),'search_files','read_file_content','download_file_content'].sort());
  for (const reference of references) {
    const tool=tools.find(t=>t.name===reference.name)!;
    expect(tool.description).toBe(reference.description);
    for (const [key,schema] of Object.entries(reference.inputSchema.properties)) expect(tool.inputSchema.properties[key]).toEqual(schema);
    if (reference.name!=='create_file') expect(tool.inputSchema.required).toEqual((reference.inputSchema as any).required ?? []);
    expect(tool.annotations.readOnlyHint).toBe(reference.annotations.readOnlyHint);
  }
  expect(tools.find(t=>t.name==='trash_file')!.annotations.destructiveHint).toBe(true);
  const validate=(name:string,args:any)=>createToolValidator(tools.find(t=>t.name===name)!.inputSchema)(args).valid;
  expect(validate('search',{createdAfter:'2026-01-01',modifiedBefore:'2026-02-01T00:00:00Z'})).toBe(true);
  expect(validate('search',{createdAfter:'January'})).toBe(false);
  expect(validate('share_file',{fileId:'f',role:'reader',type:'anyone'})).toBe(false);
  expect(validate('share_file',{fileId:'f',role:'reader',type:'user',emailAddress:'not-an-email'})).toBe(false);
  expect(validate('create_file',{title:'Notes',textContent:'# Hi',contentMimeType:'text/markdown',targetMimeType:doc,parent_folder_id:'p'})).toBe(true);
  expect(validate('create_file',{textContent:'no title'})).toBe(false);
  expect(validate('read_file',{fileId:'f',maxChars:250_001})).toBe(false);
});

test('Drive search compiles typed filters and only sorts queries Drive can sort', async () => {
  const h=harness(driveTools,[{files:[{id:'a',name:'Plan'}],nextPageToken:'n'},{files:[]},{files:[]}]);
  const result=await h.call('search',{query:"Bob's plan",mimeTypeFilter:doc,ownerEmail:'me',writerEmail:'w@example.com',sharedWithMe:true,starred:true,visibility:'anyoneWithLink',createdAfter:'2026-01-01',modifiedBefore:'2026-02-01T10:00:00Z',pageSize:20,pageToken:'p'});
  const first=h.requests[0]!.url.searchParams;
  expect(first.get('q')).toBe(`trashed = false and (name contains 'Bob\\'s plan' or fullText contains 'Bob\\'s plan') and mimeType = '${doc}' and 'me' in owners and 'w@example.com' in writers and sharedWithMe and starred = true and visibility = 'anyoneWithLink' and createdTime > '2026-01-01T00:00:00Z' and modifiedTime < '2026-02-01T10:00:00Z'`);
  expect(first.get('orderBy')).toBeNull();expect(first.get('pageSize')).toBe('20');expect(first.get('pageToken')).toBe('p');
  expect(first.get('fields')).toContain('files(id,name,mimeType,webViewLink,size,modifiedTime');
  expect(result).toEqual({files:[{id:'a',name:'Plan'}],nextPageToken:'n'});
  await h.call('search',{exact_name:'Q1 Budget.xlsx',query:'ignored',titleOnly:true});
  expect(h.requests[1]!.url.searchParams.get('q')).toBe(`trashed = false and name = 'Q1 Budget.xlsx' and mimeType != '${folder}'`);
  expect(h.requests[1]!.url.searchParams.get('orderBy')).toBe('modifiedTime desc');expect(h.requests[1]!.url.searchParams.get('pageSize')).toBe('10');
  await h.call('search',{query:'roadmap',titleOnly:true,modifiedByMe:true,mime_type_filter:folder});
  expect(h.requests[2]!.url.searchParams.get('q')).toBe(`trashed = false and name contains 'roadmap' and mimeType = '${folder}'`);
  expect(h.requests[2]!.url.searchParams.get('orderBy')).toBe('modifiedByMeTime desc');
  expect(searchQuery({}).q).toBe(`trashed = false and mimeType != '${folder}'`);
});

test('Drive search resolves a folder name, reports it for paging, and prefers files the user edited', async () => {
  const h=harness(driveTools,[{files:[]},{files:[{id:'f1',name:'Reports 2026'},{id:'f2',name:'Old reports'}]},{files:[{id:'x'},{id:'mine',modifiedByMeTime:'2026-01-01T00:00:00Z'}]}]);
  const result=await h.call('search',{folderName:'Reports',query:'budget',modifiedByMe:true});
  expect(h.requests[0]!.url.searchParams.get('q')).toBe(`mimeType = '${folder}' and trashed = false and name = 'Reports'`);
  expect(h.requests[1]!.url.searchParams.get('q')).toBe(`mimeType = '${folder}' and trashed = false and name contains 'Reports'`);
  expect(h.requests[2]!.url.searchParams.get('q')).toContain("and 'f1' in parents");
  expect(result.resolvedFolderId).toBe('f1');expect(result.otherMatchingFolders).toEqual([{id:'f2',name:'Old reports'}]);
  expect(result.files.map((f:any)=>f.id)).toEqual(['mine','x']);
  const missing=harness(driveTools,[{files:[]},{files:[]}]);
  await expect(missing.call('search',{folderName:'Nowhere'})).rejects.toThrow('No folder named "Nowhere"');
  const direct=harness(driveTools,[{files:[]}]);
  await direct.call('search',{folderId:'given',folderName:'ignored'});
  expect(direct.requests).toHaveLength(1);expect(direct.requests[0]!.url.searchParams.get('q')).toContain("'given' in parents");
});

test('Drive search inlines the top three readable results as Markdown, CSV and text', async () => {
  const long='x'.repeat(10_050);
  const h=harness(driveTools,[
    {files:[{id:'pdf',name:'Scan',mimeType:'application/pdf'},{id:'doc',name:'Doc',mimeType:doc},{id:'sheet',name:'Sheet',mimeType:sheet},{id:'link',name:'Notes link',mimeType:'application/vnd.google-apps.shortcut',shortcutDetails:{targetId:'txt',targetMimeType:'text/plain'}},{id:'json',name:'data.json',mimeType:'application/json'}]},
    ...Array.from({length:3},()=>(r:any)=>new Response(r.url.pathname.endsWith('/doc/export')?'# Heading':r.url.pathname.endsWith('/sheet/export')?xlsx():long)),
  ]);
  const result=await h.call('search',{query:'plan',includeContent:true});
  const byId=Object.fromEntries(result.files.map((f:any)=>[f.id,f]));
  expect(byId.pdf.content).toBeUndefined();expect(byId.json.content).toBeUndefined();
  expect(byId.doc).toMatchObject({content:'# Heading',contentFormat:'markdown'});
  expect(byId.sheet.content).toContain('# Budget\nName,Amount\nAlpha,12');expect(byId.sheet.content).toContain('# Actions');
  expect(byId.link.content).toHaveLength(10_000);expect(byId.link.contentTruncated).toBe(true);
  const paths=h.requests.slice(1).map(r=>r.url.pathname+'?'+r.url.searchParams.toString()).sort();
  expect(paths).toEqual(['/drive/v3/files/doc/export?mimeType=text%2Fmarkdown','/drive/v3/files/sheet/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet','/drive/v3/files/txt?alt=media&supportsAllDrives=true']);
  const failing=harness(driveTools,[{files:[{id:'doc',name:'Doc',mimeType:doc}]},Response.json({error:{message:'Export failed'}},{status:500})]);
  expect((await failing.call('search',{query:'x',includeContent:true})).files[0].contentError).toContain('Export failed');
});

test('Drive lists folders first and recent files by the chosen order', async () => {
  const h=harness(driveTools,[{files:[{id:'a'}],nextPageToken:'n'},{files:[]},{files:[{id:'r',name:'Recent'}]}]);
  expect(await h.call('list_folder',{})).toEqual({files:[{id:'a'}],nextPageToken:'n'});
  let p=h.requests[0]!.url.searchParams;
  expect(p.get('q')).toBe("'root' in parents and trashed = false");expect(p.get('orderBy')).toBe('folder,name');expect(p.get('pageSize')).toBe('50');
  await h.call('list_folder',{folderId:"it's",pageSize:200,pageToken:'t'});
  p=h.requests[1]!.url.searchParams;expect(p.get('q')).toBe("'it\\'s' in parents and trashed = false");expect(p.get('pageSize')).toBe('200');expect(p.get('pageToken')).toBe('t');
  expect(await h.call('list_recent_files',{orderBy:'lastModifiedByMe'})).toEqual({files:[{id:'r',name:'Recent'}]});
  p=h.requests[2]!.url.searchParams;expect(p.get('orderBy')).toBe('modifiedByMeTime desc');expect(p.get('pageSize')).toBe('10');expect(p.get('q')).toBe('trashed = false');
});

test('Drive reads Docs as Markdown without inline images, Sheets per tab and Slides as text, resolving shortcuts', async () => {
  const markdown='# Title\n\n![][image1]\n\n[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==>\n';
  const h=harness(driveTools,[
    {id:'short',name:'Shortcut',mimeType:'application/vnd.google-apps.shortcut',shortcutDetails:{targetId:'doc'}},{id:'doc',name:'Doc',mimeType:doc},new Response(markdown),
    {id:'sheet',name:'Budget',mimeType:sheet},new Response(xlsx()),
    {id:'deck',name:'Deck',mimeType:slides},new Response('Slide one\nSlide two'),
  ]);
  const read=await h.call('read_file',{fileId:'short'});
  expect(h.requests[1]!.url.pathname).toBe('/drive/v3/files/doc');expect(h.requests[2]!.url.pathname).toBe('/drive/v3/files/doc/export');expect(h.requests[2]!.url.searchParams.get('mimeType')).toBe('text/markdown');
  expect(read).toMatchObject({id:'doc',name:'Doc',mimeType:doc,format:'markdown',startLine:1,totalLines:5,truncated:false});
  expect(read.content).toBe('# Title\n\n![][image1]\n\n[image1]: <embedded image omitted>');
  const csv=await h.call('read_file',{fileId:'sheet'});
  expect(h.requests[4]!.url.searchParams.get('mimeType')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(csv.format).toBe('csv');expect(csv.content).toContain('# Budget\nName,Amount\nAlpha,12');expect(csv.content).toContain('# Actions\nNext\nShip');
  const text=await h.call('read_file',{fileId:'deck',startLine:2});
  expect(h.requests[6]!.url.searchParams.get('mimeType')).toBe('text/plain');expect(text).toMatchObject({content:'Slide two',startLine:2,endLine:2,totalLines:2,format:'text'});
});

test('Drive reads text files directly and refuses binaries, folders and other Google types', async () => {
  const h=harness(driveTools,[
    {id:'code',name:'main.py',mimeType:'text/x-python',size:'12'},new Response('print("hi")\n'),
    {id:'raw',name:'config',mimeType:'application/octet-stream'},new Response('key = value'),
    {id:'bin',name:'blob',mimeType:'application/octet-stream'},new Response(new Uint8Array([0,1,2])),
    {id:'pdf',name:'Scan.pdf',mimeType:'application/pdf'},
    {id:'dir',name:'Folder',mimeType:folder},
    {id:'draw',name:'Sketch',mimeType:drawing},
  ]);
  expect(await h.call('read_file',{fileId:'code'})).toMatchObject({content:'print("hi")',totalLines:1});
  expect(h.requests[1]!.url.searchParams.get('alt')).toBe('media');
  expect((await h.call('read_file',{fileId:'raw'})).content).toBe('key = value');
  await expect(h.call('read_file',{fileId:'bin'})).rejects.toThrow('download_file');
  await expect(h.call('read_file',{fileId:'pdf'})).rejects.toThrow('application/pdf');
  await expect(h.call('read_file',{fileId:'dir'})).rejects.toThrow('list_folder');
  await expect(h.call('read_file',{fileId:'draw'})).rejects.toThrow("Google Drawings files can't be read");
  await expect(h.call('read_file',{fileId:'x',startLine:5,endLine:2})).rejects.toThrow('endLine');
  expect(h.requests).toHaveLength(9);
});

test('Drive line ranges cap at whole lines and say where to continue', () => {
  const text=Array.from({length:10},(_,i)=>`line ${i+1}`).join('\n')+'\n';
  expect(lineRange(text,{startLine:3,endLine:4})).toEqual({content:'line 3\nline 4',startLine:3,endLine:4,totalLines:10,truncated:false});
  expect(lineRange(text,{startLine:2,maxChars:19})).toEqual({content:'line 2\nline 3',startLine:2,endLine:3,totalLines:10,truncated:true,nextStartLine:4});
  expect(lineRange('x'.repeat(50)+'\nshort',{maxChars:10})).toEqual({content:'x'.repeat(10),startLine:1,endLine:1,totalLines:2,truncated:true,partialLine:true,nextStartLine:2});
  expect(lineRange(text,{endLine:99}).endLine).toBe(10);
  expect(lineRange('',{})).toEqual({content:'',startLine:1,endLine:0,totalLines:0,truncated:false});
  expect(()=>lineRange(text,{startLine:11})).toThrow('past the end');
});

test('Drive downloads stored bytes up to 10 MB and exports native files by type', async () => {
  const bytes=Buffer.from([0,255,1,128,13,10]);
  const h=harness(driveTools,[
    {id:'img',name:'photo.png',mimeType:'image/png',size:'6'},new Response(bytes),
    {id:'doc',name:'Doc',mimeType:doc},
    {id:'big',name:'video.mp4',mimeType:'video/mp4',size:String(11*1024*1024)},
    {id:'draw',name:'Sketch',mimeType:drawing},new Response('<svg/>'),
    {id:'sheet',name:'Budget',mimeType:sheet},
    {id:'pdf',name:'Scan.pdf',mimeType:'application/pdf'},
  ]);
  const download=await h.call('download_file',{fileId:'img'});
  expect(download).toEqual({name:'photo.png',mimeType:'image/png',base64:bytes.toString('base64')});
  expect(h.requests[1]!.url.searchParams.get('alt')).toBe('media');
  await expect(h.call('download_file',{fileId:'doc'})).rejects.toThrow('export_file');
  await expect(h.call('download_file',{fileId:'big'})).rejects.toThrow('capped at 10 MB');
  const svg=await h.call('export_file',{fileId:'draw',format:'svg'});
  expect(h.requests[5]!.url.pathname).toBe('/drive/v3/files/draw/export');expect(h.requests[5]!.url.searchParams.get('mimeType')).toBe('image/svg+xml');
  expect(svg).toEqual({name:'Sketch',mimeType:'image/svg+xml',format:'svg',base64:Buffer.from('<svg/>').toString('base64')});
  await expect(h.call('export_file',{fileId:'sheet',format:'docx'})).rejects.toThrow('Google Sheets files export as pdf, csv, xlsx');
  await expect(h.call('export_file',{fileId:'pdf',format:'pdf'})).rejects.toThrow('download_file');
  expect(h.requests).toHaveLength(8);
  const large=harness(driveTools,[{id:'doc',name:'Doc',mimeType:doc},new Response(new Uint8Array(10*1024*1024+1))]);
  await expect(large.call('export_file',{fileId:'doc',format:'pdf'})).rejects.toThrow('exceeds 10485760 bytes');
});

test('Drive creates folders and converts Markdown or CSV on create, storing other text as-is', async () => {
  const h=harness(driveTools,[{id:'folder'},{id:'doc'},{id:'sheet'},{id:'plain'}]);
  await h.call('create_folder',{title:'Plans',parent_folder_id:'parent'});
  expect(h.requests[0]!.url.pathname).toBe('/drive/v3/files');expect(h.requests[0]!.json).toEqual({name:'Plans',mimeType:folder,parents:['parent']});
  expect(await h.call('create_file',{title:'Notes',textContent:'# Hello\n\n- one',contentMimeType:'text/markdown',targetMimeType:doc,parentId:'p'})).toEqual({id:'doc'});
  let part=multipart(h.requests[1]!.bytes);
  expect(h.requests[1]!.url.pathname).toBe('/upload/drive/v3/files');expect(h.requests[1]!.url.searchParams.get('uploadType')).toBe('multipart');
  expect(part).toEqual({meta:{name:'Notes',mimeType:doc,parents:['p']},contentType:'text/markdown',body:'# Hello\n\n- one'});
  await h.call('create_file',{title:'Budget',textContent:'a,b\n1,2',contentMimeType:'text/csv',target_mime_type:sheet});
  expect(multipart(h.requests[2]!.bytes).meta.mimeType).toBe(sheet);
  await h.call('create_file',{title:'notes.txt',textContent:'plain',contentMimeType:'',targetMimeType:''});
  part=multipart(h.requests[3]!.bytes);expect(part.meta).toEqual({name:'notes.txt',mimeType:'text/plain'});expect(part.contentType).toBe('text/plain');
  await expect(h.call('create_file',{title:'Bad',textContent:'a,b',contentMimeType:'text/csv',targetMimeType:doc})).rejects.toThrow("can't convert text/csv");
  await expect(h.call('create_file',{title:'Bad',textContent:'a',targetMimeType:slides})).rejects.toThrow('targetMimeType must be');
  await expect(h.call('create_file',{title:'Empty'})).rejects.toThrow('textContent is required');
  expect(h.requests).toHaveLength(4);
});

test('Drive keeps the earlier create_file inputs: metadata-only Google files and unconverted uploads', async () => {
  const h=harness(driveTools,[{id:'empty',name:'Blank'},{id:'kept',name:'notes.txt'}]);
  const blank=await h.call('create_file',{title:'Blank',contentMimeType:doc});
  expect(h.requests[0]!.url.pathname).toBe('/drive/v3/files');expect(h.requests[0]!.json).toEqual({name:'Blank',mimeType:doc});expect(blank.id).toBe('empty');
  await h.call('create_file',{title:'notes.txt',base64Content:Buffer.from('keep').toString('base64'),contentMimeType:'text/plain',disableConversionToGoogleType:true});
  const part=multipart(h.requests[1]!.bytes);expect(part.meta.mimeType).toBe('text/plain');expect(part.body).toBe('keep');
});

test('Drive replaces content in place: Docs from Markdown, Sheets from CSV, plain files keep their type', async () => {
  const h=harness(driveTools,[{id:'doc',name:'Doc',mimeType:doc},{id:'doc'},{id:'sheet',mimeType:sheet},{id:'sheet'},{id:'csv',mimeType:'text/csv'},{id:'csv'},{id:'deck',mimeType:slides},{id:'sheet',mimeType:sheet}]);
  await h.call('update_file_content',{fileId:'doc',textContent:'# New',contentMimeType:'text/markdown'});
  expect(h.requests[1]!.init.method).toBe('PATCH');expect(h.requests[1]!.url.pathname).toBe('/upload/drive/v3/files/doc');expect(h.requests[1]!.url.searchParams.get('uploadType')).toBe('multipart');
  expect(multipart(h.requests[1]!.bytes)).toEqual({meta:{},contentType:'text/markdown',body:'# New'});
  await h.call('update_file_content',{fileId:'sheet',textContent:'a,b'});
  expect(multipart(h.requests[3]!.bytes).contentType).toBe('text/csv');
  await h.call('update_file_content',{fileId:'csv',textContent:'x,y'});
  expect(multipart(h.requests[5]!.bytes).contentType).toBe('text/csv');
  await expect(h.call('update_file_content',{fileId:'deck',textContent:'x'})).rejects.toThrow('Google Slides tools');
  await expect(h.call('update_file_content',{fileId:'sheet',textContent:'x',contentMimeType:'text/markdown'})).rejects.toThrow('use text/csv');
  expect(h.requests).toHaveLength(8);
});

test('Drive moves by replacing parents, renames without moving, and update_file matches move_or_rename', async () => {
  const h=harness(driveTools,[{parents:['old','other']},{id:'f',name:'New',parents:['dest']},{id:'f',name:'Renamed'},{parents:['dest']},{id:'f'}]);
  expect(await h.call('move_or_rename',{fileId:'f',destination_folder_id:'dest',title:'New'})).toEqual({id:'f',name:'New',parents:['dest']});
  expect(h.requests[0]!.url.searchParams.get('fields')).toBe('parents');
  const move=h.requests[1]!;expect(move.init.method).toBe('PATCH');expect(move.url.searchParams.get('addParents')).toBe('dest');expect(move.url.searchParams.get('removeParents')).toBe('old,other');expect(move.json).toEqual({name:'New'});
  await h.call('update_file',{fileId:'f',title:'Renamed'});
  expect(h.requests[2]!.url.searchParams.get('addParents')).toBeNull();expect(h.requests[2]!.json).toEqual({name:'Renamed'});
  await h.call('update_file',{fileId:'f',parentId:'dest'});
  expect(h.requests[4]!.url.searchParams.get('addParents')).toBeNull();expect(h.requests[4]!.json).toEqual({});
  await expect(h.call('move_or_rename',{fileId:'f'})).rejects.toThrow('Provide title');
});

test('Drive copies, shares, trashes and refuses folder copies', async () => {
  const h=harness(driveTools,[{id:'src',name:'Template',mimeType:doc},{id:'copy',name:'Q3 plan'},{id:'perm',role:'writer'},{id:'perm2'},{id:'f',trashed:true},{id:'dir',name:'Dir',mimeType:folder}]);
  expect(await h.call('copy_file',{fileId:'src',title:'Q3 plan',parentId:'dest'})).toEqual({id:'copy',name:'Q3 plan'});
  expect(h.requests[1]!.url.pathname).toBe('/drive/v3/files/src/copy');expect(h.requests[1]!.json).toEqual({name:'Q3 plan',parents:['dest']});
  await h.call('share_file',{fileId:'f',role:'writer',type:'user',emailAddress:'a@example.com'});
  expect(h.requests[2]!.url.pathname).toBe('/drive/v3/files/f/permissions');expect(h.requests[2]!.url.searchParams.get('sendNotificationEmail')).toBe('false');
  expect(h.requests[2]!.json).toEqual({type:'user',role:'writer',emailAddress:'a@example.com'});
  await h.call('share_file',{fileId:'f',role:'reader',type:'domain',domain:'example.com'});
  expect(h.requests[3]!.url.searchParams.get('sendNotificationEmail')).toBeNull();expect(h.requests[3]!.json).toEqual({type:'domain',role:'reader',domain:'example.com'});
  await expect(h.call('share_file',{fileId:'f',role:'reader',type:'group'})).rejects.toThrow('emailAddress is required');
  await expect(h.call('share_file',{fileId:'f',role:'reader',type:'domain',domain:'example.com',emailAddress:'a@example.com'})).rejects.toThrow('Use emailAddress');
  await expect(h.call('share_file',{fileId:'f',role:'reader',type:'domain',domain:'example.com',sendNotification:true})).rejects.toThrow('only to users and groups');
  expect(await h.call('trash_file',{fileId:'f'})).toEqual({id:'f',trashed:true});
  expect(h.requests[4]!.init.method).toBe('PATCH');expect(h.requests[4]!.json).toEqual({trashed:true});
  await expect(h.call('copy_file',{fileId:'dir'})).rejects.toThrow("Folders can't be copied");
  expect(h.requests).toHaveLength(6);
});

test('Drive lists comments 20 at a time, adds file-level comments and resolves threads by reply', async () => {
  const h=harness(driveTools,[{comments:[{id:'c1',content:'Fix',resolved:false,replies:[]}],nextPageToken:'n'},{id:'c2',content:'Looks good'},{id:'r1',action:'resolve'},{id:'r2',content:'Reopening',action:'reopen'}]);
  expect((await h.call('list_comments',{fileId:'f',pageToken:'p',includeDeleted:true})).nextPageToken).toBe('n');
  const p=h.requests[0]!.url.searchParams;
  expect(h.requests[0]!.url.pathname).toBe('/drive/v3/files/f/comments');expect(p.get('pageSize')).toBe('20');expect(p.get('pageToken')).toBe('p');expect(p.get('includeDeleted')).toBe('true');
  expect(p.get('fields')).toContain('quotedFileContent');expect(p.get('fields')).toContain('replies(');
  await h.call('add_comment',{fileId:'f',content:'Looks good'});
  expect(h.requests[1]!.init.method).toBe('POST');expect(h.requests[1]!.json).toEqual({content:'Looks good'});expect(h.requests[1]!.url.searchParams.get('fields')).toContain('id');
  await h.call('reply_to_comment',{fileId:'f',commentId:'c1',action:'resolve',content:''});
  expect(h.requests[2]!.url.pathname).toBe('/drive/v3/files/f/comments/c1/replies');expect(h.requests[2]!.json).toEqual({action:'resolve'});
  await h.call('reply_to_comment',{fileId:'f',commentId:'c1',action:'reopen',content:'Reopening'});
  expect(h.requests[3]!.json).toEqual({content:'Reopening',action:'reopen'});
  await expect(h.call('reply_to_comment',{fileId:'f',commentId:'c1',action:''})).rejects.toThrow('content is required');
  expect(h.requests).toHaveLength(4);
});

test('Drive explains drive.file write denials as final, without changing rate limits or reads', async () => {
  const h=harness(driveTools,[{parents:['a']},denied(),Response.json({error:{message:'User Rate Limit Exceeded'}},{status:403}),denied()]);
  const error=await h.call('move_or_rename',{fileId:'f',parentId:'b'}).catch(e=>e);
  expect(error.message).toContain('Google API 403: The user has not granted the app 123 write access');
  expect(error.message).toContain('do not retry it');expect(error.message).not.toContain('Check the API is enabled');
  expect((await h.call('add_comment',{fileId:'f',content:'x'}).catch(e=>e)).message).not.toContain('do not retry');
  expect((await h.call('get_file_metadata',{fileId:'f'}).catch(e=>e)).message).not.toContain('do not retry');
});

test('Drive metadata is raw by default with the earlier snippet form on request', async () => {
  const h=harness(driveTools,[{id:'f',name:'Plan',mimeType:'text/plain',parents:['p'],owners:[{emailAddress:'o@example.com'}]},{id:'f',name:'Plan',mimeType:'text/plain'},new Response('Body')]);
  expect(await h.call('get_file_metadata',{fileId:'f'})).toEqual({id:'f',name:'Plan',mimeType:'text/plain',parents:['p'],owners:[{emailAddress:'o@example.com'}]});
  const fields=h.requests[0]!.url.searchParams.get('fields')!;
  for (const field of ['owners(','parents','shared','webViewLink','modifiedTime','size']) expect(fields).toContain(field);
  expect(await h.call('get_file_metadata',{fileId:'f',excludeContentSnippets:false})).toMatchObject({title:'Plan',contentSnippet:'Body'});
});
