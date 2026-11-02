import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Node quality checks measure the routed TLS path with bounded samples, caching and fencing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-quality-test-"));
  try {
    const cert = join(directory, "cert.pem"),
      key = join(directory, "key.pem");
    const ssl = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=speed.cloudflare.com",
        "-addext",
        "subjectAltName=DNS:speed.cloudflare.com",
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
    expect(await ssl.exited).toBe(0);
    const entry = join(directory, "runner.ts"),
      output = join(directory, "runner.mjs");
    await writeFile(
      entry,
      `
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { createQualityProbe } from ${JSON.stringify(resolve("apps/computer/src/browser-network-quality.ts"))};
let checks=0,calls=0,requests=0,uploaded=0,downloaded=0,behavior="ok",held,sni;
const server=createServer({cert:readFileSync(${JSON.stringify(cert)}),key:readFileSync(${JSON.stringify(key)})},(req,res)=>{
 requests++; assert.equal(req.headers.host,"speed.cloudflare.com");
 if(behavior==="redirect"){res.writeHead(302,{location:"https://must-not-follow.invalid"});res.end();return;}
 if(behavior==="failure"){res.writeHead(503);res.end();return;}
 if(behavior==="compressed"){res.writeHead(200,{"content-encoding":"gzip"});res.end("invalid");return;}
 if(behavior==="hold"){held=()=>res.end();return;}
 if(req.method==="POST"){
  assert.equal(req.url,"/__up"); let count=0; req.on("data",b=>count+=b.length);
  req.on("end",()=>{uploaded+=count; assert.equal(count,262144);res.end('{}');});return;
 }
 const url=new URL(req.url,"https://fixture"); assert.equal(url.pathname,"/__down");
 const bytes=Number(url.searchParams.get("bytes")); assert.ok([0,1048576].includes(bytes));
 if(behavior==="oversize"){res.end(Buffer.alloc(bytes+1));return;}
 if(behavior==="short" && bytes>0){res.end(Buffer.alloc(bytes-1));return;}
 downloaded+=bytes; res.end(Buffer.alloc(bytes));
});
server.on("secureConnection",s=>sni=s.servername);
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const port=server.address().port,route={epoch:"first",mode:"device",machineId:"air",available:true};
const client={route,available:()=>true,open:async(host,p)=>{calls++;assert.equal(host,"speed.cloudflare.com");assert.equal(p,443);return createConnection({host:"127.0.0.1",port});}};
try{
 const probe=createQualityProbe(client); const [a,b]=await Promise.all([probe(),probe()]);
 assert.deepEqual(a,b);assert.equal(requests,6);assert.equal(calls,1);assert.equal(sni,"speed.cloudflare.com");checks+=4;
 assert.equal(downloaded,1048576);assert.equal(uploaded,262144);checks+=2;
 assert.equal(a.epoch,"first");assert.equal(a.sourceId,"air");checks+=2;
 assert.ok(Number.isFinite(a.latencyMs)&&a.latencyMs>=0);assert.ok(a.downloadMbps>0);assert.ok(a.uploadMbps>0);checks+=3;
 await probe();assert.equal(requests,6);checks++;
 route.epoch="changed";await assert.rejects(probe,/Could not test/);assert.equal(requests,6);checks+=2;
 const off=createQualityProbe({...client,available:()=>false});await assert.rejects(off,/Could not test/);assert.equal(calls,1);checks+=2;
 for(const mode of ["redirect","failure","compressed","oversize","short"]){
  behavior=mode;route.epoch=mode;const bad=createQualityProbe(client),before=requests;
  await assert.rejects(bad,/Could not test/);await assert.rejects(bad,/Could not test/);
  assert.ok(requests<=before+5);checks+=3;
 }
 behavior="hold";route.epoch="stale";const stale=createQualityProbe(client)();
 while(!held)await new Promise(r=>setTimeout(r,5));route.epoch="new";held();await assert.rejects(stale,/Could not test/);checks++;
 let late,destroyed=false;
 const hanging=createQualityProbe({...client,open:()=>new Promise(r=>{late=r;})});
 await assert.rejects(hanging,/Could not test/);checks++;
 late({destroy(){destroyed=true;}});await new Promise(r=>setTimeout(r,20));assert.equal(destroyed,true);checks++;
 console.log(JSON.stringify({checks}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
`
    );
    const build = Bun.spawn(
      [process.execPath, "build", entry, "--target", "node", "--outfile", output],
      { stdout: "ignore", stderr: "inherit" }
    );
    expect(await build.exited).toBe(0);
    const runner = Bun.spawn(["node", output], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(runner.stdout).text(),
      new Response(runner.stderr).text(),
      runner.exited,
    ]);
    if (code !== 0) throw Error(stderr || stdout);
    expect(JSON.parse(stdout).checks).toBeGreaterThanOrEqual(30);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
