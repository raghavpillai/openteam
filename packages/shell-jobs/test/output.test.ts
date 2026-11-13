import { expect, test } from "bun:test";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellOutputCollector } from "../src";
import { createShellEnvironmentCapture, persistShellEnvironment } from "../src/environment";
import { SecretRedactor, redactSecrets } from "../src/redaction";

const capture=(env:Record<string,string>)=>[Buffer.from(Object.entries(env).map(([k,v])=>`${k}=${v}\0`).join(""))];

test("overlapping jobs merge independent changes but keep newer state on conflicts and unsets",async()=>{
  const root=await mkdtemp(join(tmpdir(),"shell-env-"));
  const path=join(root,"env.json");
  const initial={PWD:"/older",VALUE:"initial",REMOVE:"present",KEEP:"same"};
  try {
    await writeFile(path,JSON.stringify(initial));
    await persistShellEnvironment(path,capture({PWD:"/newer",VALUE:"foreground",KEEP:"same",NEW:"new"}),[],initial);
    await persistShellEnvironment(path,capture({...initial,VALUE:"background",BG_ONLY:"finished"}),[],initial);
    expect(JSON.parse(await readFile(path,"utf8"))).toEqual({PWD:"/newer",VALUE:"foreground",KEEP:"same",NEW:"new",BG_ONLY:"finished"});
    const baseline=JSON.parse(await readFile(path,"utf8"));
    await Promise.all(Array.from({length:12},(_,i)=>persistShellEnvironment(path,capture({...baseline,[`PARALLEL_${i}`]:String(i)}),[],baseline)));
    const merged=JSON.parse(await readFile(path,"utf8"));
    for(let i=0;i<12;i++)expect(merged[`PARALLEL_${i}`]).toBe(String(i));
    expect((await readdir(root))).toEqual(["env.json"]);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("capture cleanup never closes an unrelated file that reused its descriptor number", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-capture-descriptor-"));
  const capture = createShellEnvironmentCapture(root);
  // Bun can close an inherited numeric descriptor during spawn. Another asynchronous file open
  // may reuse that number before the command completes and its parent runs cleanup.
  closeSync(capture.fd);
  const unrelated = openSync(join(root, "unrelated"), "wx", 0o600);
  try {
    expect(unrelated).toBe(capture.fd);
    capture.closeParent();
    expect(() => writeSync(unrelated, "keep")).not.toThrow();
    expect(() => capture.closeParent()).not.toThrow();
  } finally {
    try { closeSync(unrelated); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("the collector bounds memory but keeps both ends, totals and stream breaks", () => {
  const collector = new ShellOutputCollector();
  collector.push(Buffer.from("partial"), "stdout");
  collector.push(Buffer.from("err\n"), "stderr");
  collector.push(Buffer.from("next\n"), "stderr");
  expect(collector.excerpt()).toEqual({ output: "partial\nerr\nnext\n", truncated: false });
  expect([collector.bytes, collector.lines]).toEqual([16, 2]);

  const large = new ShellOutputCollector();
  large.push(Buffer.from(`HEAD${"x".repeat(60_000)}`), "stdout");
  for (let index = 0; index < 100; index++) large.push(Buffer.from("y".repeat(1_000)), "stdout");
  large.push(Buffer.from("TAIL\n"), "stdout");
  const excerpt = large.excerpt();
  expect(excerpt.truncated).toBe(true);
  expect(excerpt.output.startsWith(`HEAD${"x".repeat(9_996)}\n\n... (output truncated) ...\n\n`)).toBe(true);
  expect(excerpt.output.endsWith(`${"y".repeat(9_995)}TAIL\n`)).toBe(true);
  expect([large.bytes, large.lines]).toEqual([160_009, 1]);
});

test("redacts every byte split including UTF-8 and overlapping credentials", () => {
  const input = "before abcdef and abc and 🔒sécret after";
  for (let split = 0; split <= Buffer.byteLength(input); split++) {
    const bytes = Buffer.from(input);
    const redactor = new SecretRedactor(["abc", "abcdef", "🔒sécret"]);
    const output = Buffer.concat([
      redactor.write(bytes.subarray(0, split)),
      redactor.write(bytes.subarray(split)),
      redactor.end(),
    ]).toString();
    expect(output).toBe("before [REDACTED] and [REDACTED] and [REDACTED] after");
  }
  expect(redactSecrets('a\\n"b', ["a\n"])).toBe('[REDACTED]"b');
});
