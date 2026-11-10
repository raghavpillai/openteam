import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("real Node TLS probes verify certificates, use only the chosen exit, and cancel sockets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-family-tls-"));
  let runner: ReturnType<typeof Bun.spawn> | undefined;
  try {
    for (const name of ["trusted", "untrusted"]) {
      const process = Bun.spawn(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(directory, name + ".key"),
          "-out",
          join(directory, name + ".pem"),
          "-days",
          "1",
          "-subj",
          "/CN=cloudflare-dns.com",
          "-addext",
          "subjectAltName=DNS:cloudflare-dns.com,DNS:dns.google",
        ],
        { stdout: "ignore", stderr: "ignore" }
      );
      expect(await process.exited).toBe(0);
    }
    const entry = join(directory, "runner.ts"),
      output = join(directory, "runner.mjs");
    await writeFile(
      entry,
      `
import assert from 'node:assert/strict';
import { createServer } from 'node:tls';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { probeNetworkFamily } from ${JSON.stringify(resolve(import.meta.dirname, "../src/network-connectivity.ts"))};
const root=${JSON.stringify(directory)};
const context=(name)=>({key:readFileSync(root+'/'+name+'.key'),cert:readFileSync(root+'/'+name+'.pem')});
const server=createServer(context('trusted'),socket=>socket.on('error',()=>{}));
const sockets=new Set();let opened=0,blockedV6=true,failedProvider=false;
server.on('tlsClientError',()=>{});
server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const open=async(host,port,signal)=>{
 assert.equal(port,443);opened++;
 if(failedProvider&&host==='1.1.1.1')throw Error('one provider unavailable');
 assert.ok(['1.1.1.1','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888'].includes(host));
 if(blockedV6&&host.includes(':'))throw Error('exit IPv6 unavailable');
 return await new Promise((resolve,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port:server.address().port,signal});
  socket.once('connect',()=>resolve(socket));socket.once('error',reject);
 });
};
try {
 assert.deepEqual(await probeNetworkFamily(open,'ipv4',new AbortController().signal),{state:'working'});
 failedProvider=true;
 assert.deepEqual(await probeNetworkFamily(open,'ipv4',new AbortController().signal),{state:'working'});
 failedProvider=false;
 assert.deepEqual(await probeNetworkFamily(open,'ipv6',new AbortController().signal),{state:'unavailable',reason:'connect_failed'});
 blockedV6=false;
 assert.deepEqual(await probeNetworkFamily(open,'ipv6',new AbortController().signal),{state:'working'});
 server.setSecureContext(context('untrusted'));
 assert.deepEqual(await probeNetworkFamily(open,'ipv4',new AbortController().signal),{state:'unavailable',reason:'tls_failed'});
 const controller=new AbortController();
 const result=probeNetworkFamily(open,'ipv4',controller.signal);controller.abort();
 await assert.rejects(result);
 await new Promise(r=>setTimeout(r,50));assert.equal(sockets.size,0);
 assert.equal(opened,12);console.log('verified TLS, both families, certificate rejection and abort cleanup');
} finally {for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
`
    );
    const build = await Bun.build({
      entrypoints: [entry],
      target: "node",
      outdir: directory,
      naming: "runner.mjs",
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn(["node", output], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(directory, "trusted.pem") },
      stdout: "pipe",
      stderr: "pipe",
    });
    runner = child;
    const timer = setTimeout(() => child.kill(), 10_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) throw Error(stderr || stdout);
    expect(stdout).toContain("verified TLS");
  } finally {
    runner?.kill();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
