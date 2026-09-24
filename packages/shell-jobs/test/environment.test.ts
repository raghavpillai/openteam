import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistShellEnvironment } from "../src/environment";

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

test("first write, sequential deletion, exclusions and recovery after a failed write",async()=>{
  const root=await mkdtemp(join(tmpdir(),"shell-env-"));
  const path=join(root,"env.json");
  try {
    await persistShellEnvironment(path,capture({BASE:"yes",ADDED:"yes",SECRET:"fixture"}),["SECRET"],{BASE:"yes"});
    expect(JSON.parse(await readFile(path,"utf8"))).toEqual({BASE:"yes",ADDED:"yes"});
    await persistShellEnvironment(path,capture({BASE:"yes"}),[],{BASE:"yes",ADDED:"yes"});
    expect(JSON.parse(await readFile(path,"utf8"))).toEqual({BASE:"yes"});
    await writeFile(path,"malformed");
    await expect(persistShellEnvironment(path,capture({BASE:"updated"}),[],{BASE:"yes"})).rejects.toThrow();
    await writeFile(path,JSON.stringify({BASE:"yes"}));
    await persistShellEnvironment(path,capture({BASE:"updated"}),[],{BASE:"yes"});
    expect(JSON.parse(await readFile(path,"utf8"))).toEqual({BASE:"updated"});
  } finally {await rm(root,{recursive:true,force:true});}
});
