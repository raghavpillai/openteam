import {expect,test} from "bun:test";
import {fileTransferCapabilities} from "../src/file-transfers";
test("file discovery exposes supported provider transfers",()=>{
  expect(fileTransferCapabilities("google-drive")).toEqual({upload:true,download:true});
  expect(fileTransferCapabilities("gmail")).toEqual({upload:true,download:true});
  expect(fileTransferCapabilities("onedrive")).toBeUndefined();
});
