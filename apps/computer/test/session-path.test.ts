import { describe, expect, test } from "bun:test";
import { assertSessionPath, disposableSessionPath } from "../src/runtime/session-path";

const sessionsDir = "/home/box/.pi/agent/sessions/openteam";

describe("Pi session paths", () => {
  test("a turn only reopens a session inside the current session root", () => {
    expect(assertSessionPath(sessionsDir, `${sessionsDir}/one_ctx.jsonl`)).toBe(
      `${sessionsDir}/one_ctx.jsonl`
    );
    expect(() =>
      assertSessionPath(sessionsDir, "/home/box/.pi/agent/sessions/legacy/x.jsonl")
    ).toThrow("outside the OpenTeam session directory");
    expect(() => assertSessionPath(sessionsDir, `${sessionsDir}/../escape.jsonl`)).toThrow(
      "outside the OpenTeam session directory"
    );
  });

  test("discarding a context also cleans a session recorded under a previous root", () => {
    expect(disposableSessionPath(sessionsDir, `${sessionsDir}/one_ctx.jsonl`)).toBe(
      `${sessionsDir}/one_ctx.jsonl`
    );
    expect(
      disposableSessionPath(
        sessionsDir,
        "/home/box/.pi/agent/sessions/legacy/2026-11-07T15-01-21-131Z_588d944c.jsonl"
      )
    ).toBe("/home/box/.pi/agent/sessions/legacy/2026-11-07T15-01-21-131Z_588d944c.jsonl");
  });

  test("discarding never leaves the sessions parent directory or drops a non-session file", () => {
    expect(disposableSessionPath(sessionsDir, "/etc/passwd")).toBeNull();
    expect(disposableSessionPath(sessionsDir, "/home/box/.pi/agent/credentials.json")).toBeNull();
    expect(
      disposableSessionPath(sessionsDir, "/home/box/.pi/agent/sessions/../../secret.jsonl")
    ).toBeNull();
    expect(disposableSessionPath(sessionsDir, "/home/box/.pi/agent/sessions")).toBeNull();
  });
});
