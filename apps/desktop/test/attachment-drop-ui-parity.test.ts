import { describe, expect, it } from "bun:test";

import { fileDragContainsFiles } from "../src/renderer/lib/file-drop";

describe("desktop attachment drop parity", () => {
  it("only activates for native file drags", () => {
    expect(fileDragContainsFiles({ types: ["Files"] })).toBe(true);
    expect(fileDragContainsFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(fileDragContainsFiles({ types: ["text/plain"] })).toBe(false);
    expect(fileDragContainsFiles(null)).toBe(false);
  });
});
