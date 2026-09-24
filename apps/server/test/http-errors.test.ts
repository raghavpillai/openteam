import { test, expect } from "bun:test";
import { Effect } from "effect";
import { ApiError } from "@openteam/contracts";
import { errorResponse } from "../src/http";
import { serviceEffect } from "../src/services/service-utils";

for(const [status,code] of [[400,"invalid_asset_path"],[403,"asset_path_protected"],[409,"external_file_review_required"]] as const) {
  test(`expected ${status} survives nested service effects`, async()=>{
    let failure:unknown;
    try {await Effect.runPromise(serviceEffect(()=>Effect.runPromise(serviceEffect(async()=>{
      throw new ApiError(status,code,"Fixture denial",{fixture:true});
    }))));} catch(error) {failure=error;}
    const response=errorResponse(failure);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({error:{code,message:"Fixture denial",details:{fixture:true}}});
  });
}

test("unexpected failures remain internal errors",async()=>{
  let failure:unknown;
  try {await Effect.runPromise(Effect.fail(new Error("Unexpected fixture failure")));}catch(error){failure=error;}
  const response=errorResponse(failure);
  expect(response.status).toBe(500);
  expect((await response.json()).error.code).toBe("internal_error");
});
