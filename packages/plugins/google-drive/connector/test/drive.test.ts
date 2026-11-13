import { expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { createToolValidator } from '@openteam/plugin-sdk/json-schema';
import { driveTools } from '../server';
import { extractContent } from '../extract';
import { harness } from '../../../test/parity-harness';

const doc='application/vnd.google-apps.document', drawing='application/vnd.google-apps.drawing', folder='application/vnd.google-apps.folder';
const denied=()=>Response.json({error:{message:'The user has not granted the app 123 write access to the file f.'}},{status:403});

test('Drive input schemas reject malformed dates, public sharing and oversized reads', () => {
  const tools=driveTools();
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

test('Drive rejects a compressed document bomb before parsing it', async () => {
  const zip=zipSync({'word/document.xml':new Uint8Array(33*1024*1024)});
  await expect(extractContent(zip,'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).rejects.toThrow('extraction limits');
});

test('Drive uses a resumable upload for large binary input and rejects off-origin upload URLs', async () => {
  const bytes=Buffer.alloc(6*1024*1024,0xff);
  const h=harness(driveTools,[new Response(null,{headers:{location:'https://www.googleapis.com/upload/drive/v3/files?upload_id=test'}}),{id:'large-upload'},new Response(null,{headers:{location:'https://attacker.example/upload'}})]);
  const args={title:'large.bin',base64Content:bytes.toString('base64'),contentMimeType:'application/octet-stream'};
  const result=await h.call('create_file',args);
  expect(result.id).toBe('large-upload');expect(h.requests[0]!.url.searchParams.get('uploadType')).toBe('resumable');
  expect(h.requests[1]!.init.method).toBe('PUT');expect(h.requests[1]!.bytes).toEqual(bytes);
  await expect(h.call('create_file',args)).rejects.toThrow('unexpected upload URL');expect(h.requests).toHaveLength(3);
});
