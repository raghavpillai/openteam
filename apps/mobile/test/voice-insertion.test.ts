import { expect, test } from "bun:test";
import { insertVoiceTranscript } from "../src/voice-insertion";

test("voice text replaces the selected phrase and preserves exact names, numbers and suffix", () => {
  expect(
    insertVoiceTranscript("Send OLD tomorrow.", "Raghav $1,203.05", { start: 5, end: 8 })
  ).toEqual({
    text: "Send Raghav $1,203.05 tomorrow.",
    selection: { start: 21, end: 21 },
  });
});
test("repeated dictation respects the caret and existing whitespace", () => {
  const first = insertVoiceTranscript("Hello", "world", null);
  expect(first.text).toBe("Hello world");
  expect(insertVoiceTranscript(first.text, "again", first.selection).text).toBe(
    "Hello world again"
  );
  expect(insertVoiceTranscript("Hello\n", "你好 👋", null).text).toBe("Hello\n你好 👋");
  expect(insertVoiceTranscript("tail", "head ", { start: 0, end: 0 }).text).toBe("head tail");
});
test("stale selection is bounded after the draft changes", () => {
  expect(insertVoiceTranscript("", "New draft", { start: 30, end: 40 }).text).toBe("New draft");
});
