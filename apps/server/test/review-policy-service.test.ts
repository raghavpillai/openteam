import { expect, test } from "bun:test";
import { ReviewPolicyService } from "../src/services/review-policy-service";

const action = { surface: "browser", summary: "Click test button", target: "test-screen", arguments: { tool: "browser_click", ref: "e1" } };

test("unconfigured and disabled review skip inference for all reviewed surfaces", async () => {
  for (const row of [null, { enabled: false, allowInstructions: ["Saved allow"], blockInstructions: ["Saved block"] }]) {
    let calls = 0;
    const service = new ReviewPolicyService({ autoReviewPolicy: { findUnique: async () => row } } as any,
      { review: async () => { calls++; throw new Error("Must not call inference"); } } as any);
    expect((await service.view()).isEnabled).toBe(false);
    for (const surface of ["browser", "computer", "boxShell", "subagentLaunch"]) {
      expect(await (await service.action({ ...action, surface })).json()).toEqual({ allowed: true });
    }
    expect(calls).toBe(0);
    if (row) expect((await service.view()).blockInstructions).toEqual(["Saved block"]);
  }
});

test("saved enabled review still calls the classifier and preserves blocks and failures", async () => {
  for (const [decision, status] of [["allow", 200], ["block", 409], ["reject", 403]] as const) {
    let calls = 0;
    const service = new ReviewPolicyService({ autoReviewPolicy: { findUnique: async () => ({ enabled: true, allowInstructions: [], blockInstructions: ["Ask before deletion"] }) } } as any,
      { review: async (input: any) => { calls++; expect(input.blockInstructions).toEqual(["Ask before deletion"]); return { decision, reason: "Fixture decision" }; } } as any);
    expect((await service.view()).isEnabled).toBe(true);
    expect((await service.action(action)).status).toBe(status);
    expect(calls).toBe(1);
  }
});

test("toggle round trip preserves rules and re-enables inference", async () => {
  let row: any = null;
  let calls = 0;
  const service = new ReviewPolicyService({ autoReviewPolicy: {
    findUnique: async () => row,
    upsert: async (args: any) => { row = { ...(row ? args.update : args.create) }; },
  } } as any, { review: async () => { calls++; return { decision: "allow", reason: "Fixture" }; } } as any);
  for (const isEnabled of [true, false, true]) {
    await service.save({ isEnabled, allowInstructions: ["Read reports"], blockInstructions: ["Ask before publishing"] });
    expect(await service.view()).toMatchObject({ isEnabled, allowInstructions: ["Read reports"], blockInstructions: ["Ask before publishing"] });
    await service.action(action);
  }
  expect(calls).toBe(2);
});
