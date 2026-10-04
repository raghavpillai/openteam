/** Runs only against real-server-qa.ts's isolated database/control endpoints. No provider connections. */
import {readFile, writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {createPrismaClient} from "../../../packages/db/src/index";
const output = process.env.SWIFT_REAL_QA_OUTPUT;
if (!output) throw new Error("An isolated QA output directory is required");
const environment = JSON.parse(await readFile(output + "/environment.json", "utf8"));
if (!/^swiftqa_reallive_\d+$/.test(environment.database) || environment.base !== "http://127.0.0.1:20020") throw new Error("Refusing a non-QA server");
const db = createPrismaClient(`postgresql://swiftqa:swiftqa-disposable-only@127.0.0.1:20002/${environment.database}`);
const base = "http://127.0.0.1:20022";
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {method, headers:{"content-type":"application/json"}, body:body === undefined ? undefined : JSON.stringify(body)});
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return response.json() as Promise<any>;
}
function check(value: unknown, label: string) { if (!value) throw new Error(label); }
const bot = await db.bot.findFirstOrThrow({where:{status:{not:"archived"}}});
const key = "native-backlog-" + randomUUID();
const install = await db.pluginInstallation.create({data:{pluginKey:key,name:"Native access QA",publisher:"Disposable QA",version:"1.0.0",manifest:{key,name:"Native access QA",version:"1.0.0",skills:[],connections:[]}}});
try {
  const account = await db.pluginConnection.create({data:{installationId:install.id,connectorKey:"qa",name:"QA account",transport:"http",authType:"none",endpoint:"https://example.invalid",status:"ready"}});
  const credentials = await request("/config");
  const login = await fetch(environment.base + "/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...credentials,rememberMe:true})});
  const token = login.headers.get("set-auth-token");
  check(token,"QA login failed");
  const oversized = await fetch(environment.base + "/api/v0/assets",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/pdf","x-file-name":"boundary.pdf"},body:new Uint8Array(26*1024*1024)});
  check(oversized.status===413,"Production regular attachment limit differs");
  const report = {passed:true,server:environment.base,database:environment.database,checks:["26 MiB regular attachment rejected with 413"]};
  await writeFile(output+"/backlog-api-acceptance.json",JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally { await db.pluginInstallation.delete({where:{id:install.id}}); await db.$disconnect(); }
