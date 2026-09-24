import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm,symlink,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {uploadPayloads} from '../../src/browser/uploads';
test('upload reader bounds files and preserves empty/Unicode data without expanding workspace access',async()=>{
 const root=await mkdtemp(join(tmpdir(),'upload-reader-'));const workspace=join(root,'workspace');await mkdir(workspace);
 try {
  const allowed=join(workspace,'résumé.txt');await writeFile(allowed,'café 日本語');
  const empty=join(workspace,'empty.txt');await writeFile(empty,'');
  const result=await uploadPayloads([allowed,empty],workspace);expect(result[0]!.buffer.toString()).toBe('café 日本語');expect(result[1]!.buffer.length).toBe(0);
  const outside=join(root,'outside');await writeFile(outside,'canary');await symlink(outside,join(workspace,'alias'));
  await expect(uploadPayloads([outside],workspace)).rejects.toThrow('outside');
  await expect(uploadPayloads([join(workspace,'alias')],workspace)).rejects.toThrow();
  const hidden=join(workspace,'.private');await writeFile(hidden,'canary');await expect(uploadPayloads([hidden],workspace)).rejects.toThrow();
  await expect(uploadPayloads([allowed],workspace,[workspace])).rejects.toThrow();
  await expect(uploadPayloads(['relative.txt'],workspace)).rejects.toThrow('absolute');
  await expect(uploadPayloads(Array(11).fill(allowed),workspace)).rejects.toThrow('ten');
  const huge=join(workspace,'large.bin');await writeFile(huge,'');await truncate(huge,25*1024*1024+1);await expect(uploadPayloads([huge],workspace)).rejects.toThrow('limit');
 }finally{await rm(root,{recursive:true,force:true});}
});
