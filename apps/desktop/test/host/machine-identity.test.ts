import {test,expect} from "bun:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadMachineIdentity} from "../../src/main/host/machine-identity";

test("desktop identities persist, remain distinct, and survive concurrent startup",async()=>{
 const root=await mkdtemp(join(tmpdir(),"machine-identity-"));
 try {
  const path=join(root,"one","machine-id");
  const ids=await Promise.all(Array.from({length:8},()=>loadMachineIdentity(path)));
  expect(new Set(ids).size).toBe(1);
  expect(await loadMachineIdentity(path)).toBe(ids[0]!);
  expect(await loadMachineIdentity(join(root,"two","machine-id"))).not.toBe(ids[0]!);
  await writeFile(path,"invalid");await expect(loadMachineIdentity(path)).rejects.toThrow("invalid");
 } finally {await rm(root,{recursive:true,force:true});}
});
