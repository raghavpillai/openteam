import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeShell, executeHostJob, terminateHostChildren } from "../../src/main/host/jobs";

test("host background completion does not restore an old exported variable",async()=>{
  const root=await mkdtemp(join(tmpdir(),"host-env-overlap-"));
  const run=(command:string,block_until_ms?:number)=>executeShell({command,working_directory:root,block_until_ms},root);
  try {
    await run('export STATEQA_VALUE=initial STATEQA_REMOVE=present');
    const bg=await run(`for i in {1..100}; do test -f '${root}/release' && break; sleep 0.05; done; sleep 0.1`,0);
    await run(`export STATEQA_VALUE=foreground; unset STATEQA_REMOVE; touch '${root}/release'`);
    await executeHostJob({kind:"await-shell",input:{shell_id:bg.shell_id,block_until_ms:5000},terminalDir:root});
    expect(JSON.stringify(await run('printf "%s|%s" "$STATEQA_VALUE" "${STATEQA_REMOVE-unset}"'))).toContain("foreground|unset");
  } finally {await terminateHostChildren();await rm(root,{recursive:true,force:true});}
});
