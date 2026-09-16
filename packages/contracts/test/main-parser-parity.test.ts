import {expect,test} from "bun:test";
import {normalizeMainToolArguments} from "../src/reference-main-parsers";
import {parseHostAwaitShellRequest} from "../src/service-protocol";
import {ShellToolInput} from "../src";
import {Schema} from "effect";

test("shell waits accept captured numeric spellings and preserve the delivery envelope",()=>{
  expect(normalizeMainToolArguments("Shell",{command:"true",block_until_ms:" 12.9 "})).toMatchObject({block_until_ms:12});
  expect(parseHostAwaitShellRequest({shell_id:12,block_until_ms:" 0 "})).toEqual({shell_id:"12",block_until_ms:0});
  expect(parseHostAwaitShellRequest({block_until_ms:"-1"})).toEqual({block_until_ms:30_000});
  expect(()=>parseHostAwaitShellRequest({block_until_ms:""})).toThrow();
  expect(()=>parseHostAwaitShellRequest({block_until_ms:"7140001"})).toThrow();
  expect(normalizeMainToolArguments("SendToUser",{type:"text",content:"done",end_turn:true})).toMatchObject({end_turn:true});
  expect(Schema.decodeUnknownSync(ShellToolInput)(normalizeMainToolArguments("Shell",{command:"true",block_until_ms:"8000000"}))).toMatchObject({block_until_ms:8_000_000});
});
