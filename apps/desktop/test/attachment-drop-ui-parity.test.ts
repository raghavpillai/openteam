import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { fileDragContainsFiles } from "../src/renderer/lib/file-drop";

const promptInputSource = readFileSync(
  new URL("../src/renderer/components/ai-elements/prompt-input.tsx", import.meta.url),
  "utf8"
);
const chatPaneSource = readFileSync(
  new URL("../src/renderer/components/openteam/chat-pane.tsx", import.meta.url),
  "utf8"
);

describe("desktop attachment drop parity", () => {
  it("only activates for native file drags", () => {
    expect(fileDragContainsFiles({ types: ["Files"] })).toBe(true);
    expect(fileDragContainsFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(fileDragContainsFiles({ types: ["text/plain"] })).toBe(false);
    expect(fileDragContainsFiles(null)).toBe(false);
  });

  it("matches the shipped full-chat overlay copy and treatment", () => {
    expect(promptInputSource).toContain("Drop files to add to chat");
    expect(promptInputSource).toContain("absolute inset-0 z-[6]");
    expect(promptInputSource).toContain("bg-[#1084fe2b]");
    expect(promptInputSource).toContain("rounded-full bg-[#1084fe] px-3 py-1.5");
    expect(promptInputSource).toContain("duration-[120ms] ease-out");
    expect(promptInputSource).not.toContain("Drop files here");
  });

  it("binds the drop behavior to the chat surface instead of only the composer", () => {
    expect(chatPaneSource).toContain('data-chat-drop-target=""');
    expect(chatPaneSource).toContain("dropTargetRef={fileDropTargetRef}");
    expect(promptInputSource).toContain('target.addEventListener("dragenter", onDragEnter)');
    expect(promptInputSource).toContain('event.dataTransfer.dropEffect = "copy"');
  });
});
