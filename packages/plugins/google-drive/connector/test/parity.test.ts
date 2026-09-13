import { expect, test } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { utils, write } from 'xlsx';
import { driveTools } from '../server';
import { extractContent } from '../extract';
import { driveQuery } from '../query';
import { harness } from '../../../test/parity-harness';

const docx=()=>zipSync({'word/document.xml':strToU8('<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>Project summary</w:t></w:r></w:p><w:p><w:r><w:t>Decision &amp; context</w:t></w:r></w:p></w:body></w:document>')});
const xlsx=()=>{const book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet([['Name','Amount'],['Alpha',12]]),'Budget');utils.book_append_sheet(book,utils.aoa_to_sheet([['Next steps'],['Ship the release']]),'Actions');return write(book,{type:'buffer',bookType:'xlsx'}) as Buffer;};

test('Drive default copy names match the source and folders reject ignored content', async () => {
  const h=harness(driveTools,[{id:'source',name:'Agenda'},{id:'copy',name:'Copy of Agenda'}]);
  const copy=await h.call('copy_file',{fileId:'source'});
  expect(copy.title).toBe('Copy of Agenda');
  expect(h.requests[1]!.json.name).toBe('Copy of Agenda');
  await expect(h.call('create_file',{title:'Folder',contentMimeType:'application/vnd.google-apps.folder',textContent:'must not disappear'})).rejects.toThrow('Folders cannot contain');
});

test('PowerPoint extraction follows presentation order and each slide’s notes relationship', async () => {
  const xml=(text:string)=>strToU8(text);
  const bytes=zipSync({
    'ppt/presentation.xml':xml('<p:presentation><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>'),
    'ppt/_rels/presentation.xml.rels':xml('<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="/ppt/slides/slide2.xml"/></Relationships>'),
    'ppt/slides/slide1.xml':xml('<a:p><a:r><a:t>First source slide</a:t></a:r></a:p>'),
    'ppt/slides/slide2.xml':xml('<a:p><a:r><a:t>Reordered opening slide</a:t></a:r></a:p>'),
    'ppt/slides/_rels/slide1.xml.rels':xml('<Relationships><Relationship Id="notes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide9.xml"/></Relationships>'),
    'ppt/notesSlides/notesSlide9.xml':xml('<a:p><a:r><a:t>Correct linked notes</a:t></a:r></a:p>'),
  });
  const result=await extractContent(bytes,'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  expect(result.text).toStartWith('# Slide 1\nReordered opening slide');
  expect(result.text).toContain('# Slide 2\nFirst source slide\nNotes:\nCorrect linked notes');
});

test('Drive structured query aliases preserve literals, grouping, owners and parents', () => {
  expect(driveQuery("title contains 'owner = title' and (parentId = 'abc' or owner != 'me') and sharedWithMe = false")).toBe("name contains 'owner = title' and ( ( 'abc' in parents ) or not ( 'me' in owners ) ) and not sharedWithMe".replaceAll('( \'',"('").replaceAll("parents )","parents)").replaceAll("owners )","owners)"));
  expect(driveQuery("Bob's \\notes")).toBe("fullText contains 'Bob\\'s \\\\notes'");
  expect(()=>driveQuery('owner = me')).toThrow('quoted');
});

test('Drive extracts every workbook sheet, DOCX paragraphs, slide text and OpenDocument text', async () => {
  const workbook=await extractContent(xlsx(),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(workbook.text).toContain('# Budget');expect(workbook.text).toContain('Alpha,12');expect(workbook.text).toContain('# Actions');expect(workbook.text).toContain('Ship the release');
  const doc=await extractContent(docx(),'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  expect(doc.text).toBe('Project summary\nDecision & context');
  const slides=zipSync({'ppt/slides/slide1.xml':strToU8('<p:sld><a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:sld>'),'ppt/notesSlides/notesSlide1.xml':strToU8('<p:notes><a:p><a:r><a:t>Presenter context</a:t></a:r></a:p></p:notes>')});
  expect((await extractContent(slides,'application/vnd.openxmlformats-officedocument.presentationml.presentation')).text).toContain('Presenter context');
  const odt=zipSync({'content.xml':strToU8('<office:document><text:p>Hello <text:span>OpenDocument</text:span></text:p></office:document>')});
  expect((await extractContent(odt,'application/vnd.oasis.opendocument.text')).text).toContain('Hello OpenDocument');
});

test('Drive rejects a compressed document bomb before parsing it', async () => {
  const zip=zipSync({'word/document.xml':new Uint8Array(33*1024*1024)});
  await expect(extractContent(zip,'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).rejects.toThrow('extraction limits');
});

test('Drive native documents include real comment threads, anchors and paginated replies', async () => {
  const h=harness(driveTools,[{id:'doc',name:'Document',mimeType:'application/vnd.google-apps.document'},new Response(docx()),
    {comments:[{id:'c1',content:'Please clarify',author:{displayName:'Reviewer'},quotedFileContent:{value:'Project summary'},replies:[{id:'r1',content:'Done',author:{displayName:'Author'}}],resolved:true}],nextPageToken:'next'},
    {comments:[{id:'c2',content:'Follow-up',quotedFileContent:{value:'Unknown selection'}}]}]);
  const value=await h.call('read_file_content',{fileId:'doc',includeComments:true});
  expect(h.requests[1]!.url.searchParams.get('mimeType')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  expect(value.fileContent).toContain('Project summary [comment:c1]');
  expect(value.commentThreads).toHaveLength(2);expect(value.commentThreads[0].replies[0].content).toBe('Done');
  expect(value.commentThreads[0].status).toBe('RESOLVED');expect(h.requests[3]!.url.searchParams.get('pageToken')).toBe('next');
});

test('Drive reads content above 64 KB and returns byte-exact downloads', async () => {
  const bytes=Buffer.from('Large document ✓\n'.repeat(10_000));
  const file={id:'large',name:'large.txt',mimeType:'text/plain',size:String(bytes.length)};
  const h=harness(driveTools,[file,new Response(bytes),file,new Response(bytes)]);
  expect((await h.call('read_file_content',{fileId:'large'})).fileContent).toBe(bytes.toString());
  const download=await h.call('download_file_content',{fileId:'large'});
  expect(Buffer.from(download.content,'base64')).toEqual(bytes);expect(download.title).toBe('large.txt');
});

test('Drive creates binary uploads without UTF-8 corruption and supports conversion choices', async () => {
  const bytes=Buffer.from([0,255,254,13,10,128]);
  const h=harness(driveTools,[{id:'uploaded',name:'asset.bin',mimeType:'application/octet-stream'},{}]);
  await h.call('create_file',{title:'asset.bin',base64Content:bytes.toString('base64'),contentMimeType:'application/octet-stream',disableConversionToGoogleType:true,parentId:'parent'});
  expect(h.requests[0]!.bytes.includes(bytes)).toBe(true);expect(h.requests[0]!.bytes.toString()).toContain('"parents":["parent"]');
  await h.call('create_file',{title:'Agenda',textContent:'Meeting notes',contentMimeType:'text/plain'});
  expect(h.requests[1]!.bytes.toString()).toContain('application/vnd.google-apps.document');
  await expect(h.call('create_file',{title:'Bad',textContent:'a',base64Content:'YQ==',contentMimeType:'text/plain'})).rejects.toThrow('only one');
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

test('Drive metadata snippets respect exclusion and do not hide per-file failures', async () => {
  const h=harness(driveTools,[{id:'a',name:'A',mimeType:'text/plain',owners:[{emailAddress:'owner@example.com'}]},new Response('Long text '.repeat(600)),{id:'b',name:'B',mimeType:'text/plain'}]);
  const result=await h.call('get_file_metadata',{fileId:'a',snippetVerbosity:'BRIEF'});
  expect(result.contentSnippet).toHaveLength(1000);expect(result.owner).toBe('owner@example.com');
  const excluded=await h.call('get_file_metadata',{fileId:'b',excludeContentSnippets:true});expect(excluded.contentSnippet).toBeUndefined();expect(h.requests).toHaveLength(3);
});

test('Drive permissions follow all pages by default', async () => {
  const h=harness(driveTools,[{permissions:[{type:'user',role:'reader'}],nextPageToken:'next'},{permissions:[{type:'group',role:'writer'}]}]);
  const value=await h.call('get_file_permissions',{fileId:'f'});expect(value.permissions).toHaveLength(2);expect(h.requests[1]!.url.searchParams.get('pageToken')).toBe('next');
});
