import {expect, test} from "bun:test";
import {parseReadTranscriptInput} from "@openteam/contracts/read-transcript";
import {boundTranscriptValue, transcriptToolProjection} from "../src/read-transcript";
test("strict bounded selectors and cursors", () => {
  expect(parseReadTranscriptInput({})).toEqual({limit:30, before:undefined});
  expect(parseReadTranscriptInput({subagent_id:" worker ",before:0,limit:200}).subagent_id).toBe("worker");
  for(const input of [{limit:0},{limit:201},{limit:1.2},{before:-1},{before:Infinity},{agent_id:"a",session_id:"b"},{subagent_id:[]},{extra:true},{toString:1},[]]) expect(()=>parseReadTranscriptInput(input)).toThrow();
});
test("projection excludes arguments, hidden fields, arbitrary details and held form results", () => {
  const result = transcriptToolProjection({tool:"CallDynamicTool",arguments:{toolName:"request_user_form",password:"DO_NOT_RETURN"},thinking:"PRIVATE",result:{content:[{type:"text",text:"HELD_FORM"}],details:{token:"SECRET"}}});
  expect(result).toEqual({tool:"request_user_form",output_omitted:true});
  expect(transcriptToolProjection({type:"commandExecution",command:"echo ok",result:{content:[{type:"text",text:"ok"},{type:"thinking",text:"PRIVATE"}],details:{environment:"SECRET"}}})).toEqual({tool:"Shell",command:"echo ok",output:"ok"});
});
test("credential redaction precedes truncation", () => {
  expect(boundTranscriptValue('Bearer abcdef12345 PASSWORD=hello')).not.toContain('abcdef12345');
  expect(boundTranscriptValue('Bearer abcdef12345 PASSWORD=hello')).not.toContain('hello');
  expect(boundTranscriptValue('a'.repeat(2500)+'z'.repeat(2500),100)).toBe('a'.repeat(50)+'\n[truncated: 4900 characters omitted from middle]\n'+'z'.repeat(50));
});

test("long command observations retain their final result while redacting both ends", () => {
  const projection = transcriptToolProjection({type:"commandExecution", command:"python3 diagnostic.py",
    result:{content:[{type:"text",text:'BEGIN PASSWORD=first-secret\n'+'record\n'.repeat(4000)+'\nRESULT=completed\nPASSWORD=last-secret'}],details:{exitCode:0}}});
  const text = boundTranscriptValue(projection,2000);
  expect(text).toContain('python3 diagnostic.py');
  expect(text).toContain('RESULT=completed');
  expect(text).toContain('omitted from middle');
  expect(text).not.toContain('first-secret');
  expect(text).not.toContain('last-secret');
  expect(boundTranscriptValue('short')).toBe('short');
  expect(boundTranscriptValue('abcdef',1)).toBe('a\n[truncated: 5 characters omitted from middle]\n');
  expect(boundTranscriptValue({password:'never-visible', nested:{authorization:'private-value'}})).not.toContain('never-visible');
  expect(boundTranscriptValue({password:'never-visible', nested:{authorization:'private-value'}})).not.toContain('private-value');
});

test("browser action observations survive history recovery without exposing input arguments or private details", () => {
  for (const tool of ['browser_navigate','browser_click','browser_mouse_click_xy','browser_press_key','browser_hover','browser_scroll','browser_wait_for','browser_find']) {
    const value = transcriptToolProjection({tool, arguments:{text:'PRIVATE_INPUT',url:'PRIVATE_ARGUMENT'},
      result:{content:[{type:'text',text:'Pressed Enter\nCurrent page: Help (https://docs.example/search)\nNo results found\nPASSWORD=hidden-secret'},
        {type:'image',data:'PRIVATE_IMAGE'},{type:'thinking',text:'PRIVATE_REASONING'}],details:{token:'PRIVATE_DETAIL'}}});
    const text=boundTranscriptValue(value);
    expect(text).toContain('No results found'); expect(text).toContain('Pressed Enter');
    for(const secret of ['PRIVATE_INPUT','PRIVATE_ARGUMENT','PRIVATE_IMAGE','PRIVATE_REASONING','PRIVATE_DETAIL','hidden-secret']) expect(text).not.toContain(secret);
  }
});

test("browser form entry, arbitrary execution and approval results remain excluded", () => {
  for(const tool of ['browser_type','browser_fill','browser_fill_form','browser_file_upload','browser_cdp','request_user_form','UnknownTool']) {
    expect(transcriptToolProjection({tool,arguments:{text:'PRIVATE_INPUT'},result:{content:[{type:'text',text:'PRIVATE_RESULT'}]}}))
      .toEqual({tool,output_omitted:true});
  }
});

test("desktop history retains screenshot receipts after interruption without replaying inputs or images", () => {
  for (const tool of ["Computer", "Screenshot"]) {
    const value = transcriptToolProjection({tool,
      arguments: {action: "type", text: "PRIVATE_TYPED_INPUT", then: [{action: "key", key: "Return"}]},
      result: {content: [
        {type: "text", text: "Screenshot saved to /workspace/shared/screenshots/desktop.png"},
        {type: "image", data: "PRIVATE_IMAGE"},
        {type: "thinking", text: "PRIVATE_REASONING"},
      ], details: {path: "/private/detail", token: "PRIVATE_TOKEN"}},
    });
    expect(value).toEqual({tool, output: "Screenshot saved to /workspace/shared/screenshots/desktop.png"});
    expect(boundTranscriptValue(value)).not.toContain("PRIVATE_");
  }
});
