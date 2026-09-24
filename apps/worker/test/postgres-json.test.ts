import { expect, test } from "bun:test";
import { postgresJson, postgresText } from "../src/postgres-json";
import { Projection } from "../src/projection";

test("projection text is PostgreSQL safe while retaining valid Unicode and literal escapes",()=>{
  expect(postgresText("a\0b\ud800c\udc00 🌍 \\u0000")).toBe("a�b�c� 🌍 \\u0000");
  expect(postgresJson({"k\0": ["v\0",null,42]})).toEqual({"k�":["v�",null,42]});
});

test("a tool result containing binary text does not pass NUL to projection storage",async()=>{
  const writes:any[]=[];
  const tx={runItem:{upsert:async(x:any)=>{writes.push(x);return {id:"item"}}},event:{create:async()=>({})}};
  const p=new Projection({$transaction:async(fn:any)=>fn(tx)} as never);
  await p.apply("run","conversation","bot",{type:"item.completed",turnId:"run",item:{id:"tool",type:"dynamicToolCall",tool:"Read",status:"completed",result:{content:[{type:"text",text:"before\0after"}]}}} as any);
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(writes)).toContain("before�after");
  expect(JSON.stringify(writes)).not.toContain("\\u0000");
});
