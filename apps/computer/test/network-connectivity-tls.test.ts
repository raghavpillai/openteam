import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { runInNode, selfSignedCertificate } from "./node-runner";
import { tempDirs } from "./temp";
const tempDir = tempDirs();

test("real Node TLS probes verify certificates, use only the chosen exit, and cancel sockets", async () => {
  const directory = await tempDir("openteam-family-tls-");
  for (const name of ["trusted", "untrusted"]) await selfSignedCertificate(directory, ["cloudflare-dns.com", "dns.google"], name);
  const stdout = await runInNode(directory, { source: `
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
` }, { env: { NODE_EXTRA_CA_CERTS: join(directory, "trusted.pem") }, timeoutMs: 10_000 });
  expect(stdout).toContain("verified TLS");
}, 15_000);
