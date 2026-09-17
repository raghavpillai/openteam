import { expect, test } from "bun:test";
import { nativeApprovalOutcome } from "../src/activity";

test("an action acknowledged before its HTTP response remains in progress, then records failure", () => {
  expect(
    nativeApprovalOutcome({ status: "pending", details: { actionState: "running" } })
  ).toMatchObject({ pending: false, filling: true });
  expect(
    nativeApprovalOutcome({
      status: "accepted",
      details: { actionState: "failed", resolution: "always_allow" },
    })
  ).toMatchObject({ failed: true, filling: false, status: "Failed" });
});

test("refusal wins over stale native action metadata and old accepted receipts still render", () => {
  for (const [status, expected] of [
    ["declined", "Denied"],
    ["expired", "Expired"],
    ["cancelled", "Cancelled"],
  ] as const) {
    for (const actionState of ["running", "completed", "failed"])
      expect(nativeApprovalOutcome({ status, details: { actionState } })).toMatchObject({
        pending: false,
        filling: false,
        accepted: false,
        failed: false,
        status: expected,
      });
  }
  expect(
    nativeApprovalOutcome({ status: "accepted", details: { resolution: "always_allow" } })
  ).toMatchObject({ status: "Always allowed", filling: false });
});
