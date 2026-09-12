import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const [auditRoot, output] = process.argv.slice(2);
const root = await mkdtemp(join(tmpdir(), "openteam-computer-ab-"));
const id = "11111111-1111-4111-8111-111111111111";
const arms: Record<string, any> = {};
const messages = Array.from({ length: 2000 }, (_, i) => ({
  role: i % 3 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}: ${"fixture text ".repeat(20)}` }],
  timestamp: 1000 + i,
}));
const results: any[] = [];
async function paired(name: string, run: (arm: string, iteration: number) => unknown, samples = 40, warmups = 8) {
  const values: Record<string, number[]> = { baseline: [], candidate: [] };
  for (let i = -warmups; i < samples; i++) {
    const outputs: any = {};
    for (const arm of i % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
      const start = performance.now();
      outputs[arm] = await run(arm, i + warmups);
      if (i >= 0) values[arm]!.push(performance.now() - start);
    }
    assert.deepStrictEqual(outputs.candidate, outputs.baseline, `${name} differs`);
  }
  results.push({ name, unit: "milliseconds", samples: values });
  console.log(JSON.stringify({ name, medianMs: Object.fromEntries(Object.entries(values).map(([arm, vals]) => [arm, [...vals].sort((a,b)=>a-b)[Math.floor(vals.length/2)]])) }));
}
try {
  for (const arm of ["baseline", "candidate"]) {
    const source = join(auditRoot!, arm, "apps/computer/src");
    const { BotAgentStore } = await import(join(source, "bot-agent-store.ts"));
    const { BoxStoreSync } = await import(join(source, "box-store-sync.ts"));
    const compaction = await import(join(source, "bot-compaction.ts"));
    const local = join(root, arm);
    const store = new BotAgentStore(join(local, "sand"), undefined, { now: () => 1788000000000 });
    await store.openForWake(id);
    const transcript = messages.slice(0,1000).map((entry,i) => ({id:`entry-${i}`, entry}));
    await store.replaceTranscriptEntries(id, transcript);
    const home = join(local, "home");
    const sand = join(home, "sand-data");
    const workspace = join(local, "workspace");
    await mkdir(workspace, { recursive: true });
    for (let i=0;i<250;i++) {
      const directory = join(sand, "agents", `agent-${i}`);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory,"profile.json"), JSON.stringify({name:`Bot ${i}`}));
      await writeFile(join(directory,"settings.json"), "{}");
      if (i < 10) {
        const db = new Database(join(directory,"store.db"), { create:true });
        db.exec("PRAGMA journal_mode=WAL; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES ('fixture')");
        db.close();
      }
    }
    const sync = new BoxStoreSync({ home, sandRoot:sand, workspaceRoot:workspace, storeRoot:join(local,"box-store") });
    await sync.snapshotOut();
    arms[arm] = {store,sync,compaction,local,sand};
  }
  await paired("compaction-digest-2000-messages", arm => arms[arm].compaction.botMessageDigest(messages));
  await paired("compaction-partition-2000-messages", arm => arms[arm].compaction.partitionForBotSummary(messages));
  await paired("sqlite-publish-100-envelopes", (arm, iteration) => arms[arm].store.appendConversationEnvelopes(id,
    Array.from({length:100},(_,i)=>({role:"user",content:`batch-${iteration}-${i}`,eventId:`event-${iteration}-${i}`}))));
  await paired("sqlite-read-transcript-1000", arm => arms[arm].store.readTranscriptEntries(id, {limit:1000}));
  await paired("sqlite-kv-200-roundtrips", async (arm, iteration) => {
    const store=arms[arm].store;let last;
    for(let i=0;i<200;i++){await store.writeKv(id,"key",`${iteration}-${i}`);last=await store.readKv(id,"key");}
    return last;
  });
  await paired("snapshot-250-agents-unchanged", async arm => {
    await arms[arm].sync.snapshotOut();
    const manifest=JSON.parse(await readFile(join(arms[arm].local,"box-store/manifest.json"),"utf8"));
    return Object.entries(manifest.files).map(([key,v]:any)=>[key,v.hash ?? v.sha256 ?? v.digest,v.size]);
  },24,4);
  await paired("snapshot-one-dirty-agent", async (arm, iteration) => {
    await writeFile(join(arms[arm].sand,"agents/agent-249/profile.json"),JSON.stringify({name:`Changed ${iteration}`}));
    await arms[arm].sync.snapshotOut({agentIds:["agent-249"]});
    return undefined;
  });
  // Persisted records must remain byte-identical across both implementations.
  for(const arm of ["baseline","candidate"])await arms[arm].store.closeAll();
  const rows: any = {};
  for(const arm of ["baseline","candidate"]){
    const db=new Database(join(arms[arm].store.agentDirectory(id),"conversation-blobs.db"),{readonly:true});
    rows[arm]=db.query("SELECT id, hex(data) AS data FROM blobs ORDER BY id").all();db.close();
  }
  assert.deepStrictEqual(rows.candidate,rows.baseline);
  await Bun.write(output!, JSON.stringify({samples:40,warmups:8,results,blobRecords:rows.baseline.length,persistedBlobDigest:createHash("sha256").update(JSON.stringify(rows.baseline)).digest("hex")},null,2));
} finally {
  for(const arm of Object.values(arms))await arm.store.closeAll();
  await rm(root,{recursive:true,force:true});
}
