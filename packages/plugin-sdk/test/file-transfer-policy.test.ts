import {expect,test} from "bun:test";
import {fileTransferCapabilities,fileTransferPolicy} from "../src/file-transfer-policy";

test("unified file discovery honors provider capabilities and existing connector denials",()=>{
  expect(fileTransferCapabilities("google-drive",[],[],"bot")).toEqual({upload:true,download:true});
  expect(fileTransferCapabilities("unrelated",[],[],"bot")).toBeUndefined();
  const policies=[{toolName:"create_file",botId:null,enabled:false,decision:"deny" as const}];
  expect(fileTransferCapabilities("google-drive",policies,[{name:"create_file"}],"bot")).toEqual({upload:false,download:true});
  expect(fileTransferPolicy([],[],"bot","upload_file")).toMatchObject({decision:"prompt",enabled:true});
});
