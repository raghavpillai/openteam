import { expect, test } from 'bun:test';
import { utils, write } from 'xlsx';
import { createToolValidator } from '@openteam/plugin-sdk/json-schema';
import { referenceTools } from '../../../_shared/reference';
import { driveTools } from '../server';
import { lineRange as range } from '../content';
import { harness } from '../../../test/parity-harness';

const doc='application/vnd.google-apps.document', sheet='application/vnd.google-apps.spreadsheet', slides='application/vnd.google-apps.presentation', drawing='application/vnd.google-apps.drawing', folder='application/vnd.google-apps.folder';
const xlsx=()=>{const book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet([['Name','Amount'],['Alpha',12]]),'Budget');utils.book_append_sheet(book,utils.aoa_to_sheet([['Next'],['Ship']]),'Actions');return new Uint8Array(write(book,{type:'buffer',bookType:'xlsx'}) as Buffer);};
const lineRange=(text:string,a:Parameters<typeof range>[1]):Record<string,unknown>=>range(text,a);
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

test('Drive explains drive.file write denials as final, without changing rate limits or reads', async () => {
  const h=harness(driveTools,[{parents:['a']},denied(),Response.json({error:{message:'User Rate Limit Exceeded'}},{status:403}),denied()]);
  const error=await h.call('move_or_rename',{fileId:'f',parentId:'b'}).catch(e=>e);
  expect(error.message).toContain('Google API 403: The user has not granted the app 123 write access');
  expect(error.message).toContain('do not retry it');expect(error.message).not.toContain('Check the API is enabled');
  expect((await h.call('add_comment',{fileId:'f',content:'x'}).catch(e=>e)).message).not.toContain('do not retry');
  expect((await h.call('get_file_metadata',{fileId:'f'}).catch(e=>e)).message).not.toContain('do not retry');
});
