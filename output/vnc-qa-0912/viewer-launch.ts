// Ephemeral loopback launcher for the disposable QA screen. Credentials stay in memory.
const proc = Bun.spawn(["docker", "exec", "openteam-server-1", "bun", "/tmp/vnc-qa-server-probe.js", "viewer-url"], {stdout:"pipe", stderr:"inherit"});
const output = await new Response(proc.stdout).text();
if (await proc.exited) throw new Error("Viewer setup failed");
const target = output.match(/^QA_VIEWER=(.+)$/m)?.[1];
if (!target) throw new Error("QA viewer is not ready");
Bun.serve({hostname:"127.0.0.1", port:6174, fetch(request){
  if (new URL(request.url).pathname !== "/vnc-qa-0912") return new Response("Not found", {status:404});
  return new Response(null,{status:302,headers:{location:target,"cache-control":"no-store"}});
}});
console.log("Disposable QA viewer launcher ready on loopback port 6174.");
