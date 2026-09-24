import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolExecutor } from "../src/native-tool-executor";

test("background completion preserves newer foreground cwd and exported/unset variables", async () => {
  const root=await mkdtemp(join(tmpdir(),"shell-overlap-"));
  try {
    await mkdir(join(root,"older")); await mkdir(join(root,"newer"));
    const ex=new NativeToolExecutor({agentDir:root,controlToken:"fixture"});
    const run=(command:string,block_until_ms?:number)=>ex.shell({command,block_until_ms},root,undefined,undefined,"one");
    await run(`cd '${root}/older'; export STATEQA_VALUE=initial STATEQA_REMOVE=remove_me`);
    const bg=await run(`while ! test -f '${root}/release'; do sleep 0.05; done; sleep 0.1; printf background`,0);
    await run(`cd '${root}/newer'; export STATEQA_VALUE=foreground; unset STATEQA_REMOVE; touch '${root}/release'`);
    await ex.awaitShell({shell_id:String(bg.details.shellId),block_until_ms:5000},undefined,"one");
    const result=await run('printf "%s|%s|%s" "$PWD" "$STATEQA_VALUE" "${STATEQA_REMOVE-unset}"');
    expect(JSON.stringify(result)).toContain(`${root}/newer|foreground|unset`);
  } finally {await rm(root,{recursive:true,force:true});}
});
