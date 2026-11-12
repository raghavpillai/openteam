import { expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { utils, write } from 'xlsx';
import { driveTools } from '../server';
import { extractContent } from '../extract';
import { harness } from '../../../test/parity-harness';

const xlsx=()=>{const book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet([['Name','Amount'],['Alpha',12]]),'Budget');utils.book_append_sheet(book,utils.aoa_to_sheet([['Next steps'],['Ship the release']]),'Actions');return write(book,{type:'buffer',bookType:'xlsx'}) as Buffer;};

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
