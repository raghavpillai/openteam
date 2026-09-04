import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_RECOVERY_RUN_STATUSES,
  subagentRestartError,
} from "../../src/services/subagent/recovery";

describe("subagent restart recovery parity", () => {
  test("fails queued children as well as children already executing", () => {
    expect(SUBAGENT_RECOVERY_RUN_STATUSES).toEqual(["queued", "running", "waiting_approval"]);
  });

  test("tells the parent to relaunch work instead of implying an automatic resume", () => {
    expect(subagentRestartError).toMatchObject({ code: "runtime_restart" });
    expect(subagentRestartError.message).toContain("child is no longer running");
    expect(subagentRestartError.message).toContain("dispatch a fresh background task");
  });
});
