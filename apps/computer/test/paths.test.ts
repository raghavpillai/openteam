import { describe, expect, test } from "bun:test";
import { PathContainmentError, resolveWorkspacePath } from "../src/paths";

describe("computer workspace containment", () => {
  test("allows the shared root and descendants", () => {
    expect(resolveWorkspacePath("/workspace", "/workspace")).toBe("/workspace");
    expect(resolveWorkspacePath("/workspace/bots/research", "/workspace")).toBe(
      "/workspace/bots/research"
    );
  });

  test("rejects traversal and sibling-prefix paths", () => {
    expect(() => resolveWorkspacePath("/workspace/../etc", "/workspace")).toThrow(
      PathContainmentError
    );
    expect(() => resolveWorkspacePath("/workspace-private", "/workspace")).toThrow(
      PathContainmentError
    );
  });
});
