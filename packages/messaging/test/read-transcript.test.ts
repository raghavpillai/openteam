import {expect, test} from "bun:test";
import {parseReadTranscriptInput} from "@openteam/contracts/read-transcript";
import {boundTranscriptValue, transcriptToolProjection} from "../src/read-transcript";
test("strict bounded selectors and cursors", () => {
  for (const input of [{}, {in:" "}, {in:"session"}, {in:" this "}]) expect(parseReadTranscriptInput(input)).toEqual({in:"session", limit:30, before:undefined});
  expect(parseReadTranscriptInput({in:" worker ",before:0,limit:200}).in).toBe("worker");
  expect(()=>parseReadTranscriptInput({in:"all"})).toThrow("ReadTranscript reads one transcript at a time: omit `in` for this session, or pass one id.");
  // The three retired ids are unknown fields now.
  for(const input of [{limit:0},{limit:201},{limit:1.2},{before:-1},{before:Infinity},{agent_id:"a"},{session_id:"b"},{subagent_id:"c"},{in:[]},{extra:true},{toString:1},[]]) expect(()=>parseReadTranscriptInput(input)).toThrow();
});
test("credential redaction precedes truncation", () => {
  expect(boundTranscriptValue('Bearer abcdef12345 PASSWORD=hello')).not.toMatch(/abcdef12345|hello/);
  expect(boundTranscriptValue('a'.repeat(2500)+'z'.repeat(2500),100)).toBe('a'.repeat(50)+'\n[truncated: 4900 characters omitted from middle]\n'+'z'.repeat(50));
});

test("history keeps browser observations, never inputs, images, reasoning, details or form-entry results", () => {
  const result = (text: string) => ({content:[{type:'text',text},{type:'image',data:'PRIVATE_IMAGE'},{type:'thinking',text:'PRIVATE_REASONING'}],details:{token:'PRIVATE_DETAIL'}});
  const call = (tool: string, text: string) => ({tool,arguments:{text:'PRIVATE_INPUT',url:'PRIVATE_ARGUMENT',then:[{action:'key',key:'Return'}]},result:result(text)});
  const browser = 'Pressed Enter\nCurrent page: Help (https://docs.example/search)\nNo results found';
  for (const tool of ['browser_navigate','browser_click','browser_press_key','browser_hover','browser_wait_for','browser_find'])
    expect(transcriptToolProjection(call(tool, browser))).toEqual({tool, output: browser});
  for (const tool of ['browser_type','browser_fill','browser_fill_form','browser_file_upload','browser_cdp','RequestUserForm','UnknownTool'])
    expect(transcriptToolProjection(call(tool, 'PRIVATE_RESULT'))).toEqual({tool,output_omitted:true});
  // A form requested through the dynamic-tool wrapper is held the same way.
  expect(transcriptToolProjection({tool:"CallDynamicTool",arguments:{toolName:"RequestUserForm",password:"DO_NOT_RETURN"},result:result("HELD_FORM")})).toEqual({tool:"RequestUserForm",output_omitted:true});
});
