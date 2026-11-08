import { describe, expect, test } from "bun:test";
import {
  NARRATION_OPENING_ALLOWANCE_MS,
  NARRATION_SILENCE_MS,
  SaidLog,
  VoiceNarrator,
  cleanNarration,
  describeAction,
  narrationPrompt,
} from "../../src/runtime/voice-narration";

/** A manual clock so timers fire only when the test advances time. */
const harness = (lines: string[] = ["I'm on it."]) => {
  let time = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const delivered: string[] = [];
  const prompts: string[] = [];
  let inferCalls = 0;
  const narrator = new VoiceNarrator(
    { cwd: "/tmp" },
    { model: "p/m", reasoning: "minimal", userRequest: "find my invoice" },
    {
      now: () => time,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: time + ms, fn });
        return id;
      },
      clearTimer: (handle) => void timers.delete(handle as number),
      infer: async (request) => {
        prompts.push(request.prompt);
        return lines[Math.min(inferCalls++, lines.length - 1)]!;
      },
      deliver: async (text) => void delivered.push(text),
    }
  );
  const advance = async (ms: number) => {
    const target = time + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      time = due[1].at;
      due[1].fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    time = target;
  };
  return { narrator, advance, delivered, prompts, calls: () => inferCalls };
};

describe("voice narrator timing", () => {
  test("the first line waits for the server's acknowledgement plus the silence limit", async () => {
    const h = harness(["I'm looking into that now."]);
    h.narrator.begin();
    h.narrator.toolStarted("WebSearch");
    await h.advance(NARRATION_SILENCE_MS + NARRATION_OPENING_ALLOWANCE_MS - 1);
    expect(h.delivered).toEqual([]);
    await h.advance(2);
    expect(h.delivered).toEqual(["I'm looking into that now."]);
  });

  test("says nothing when the agent answers before the first line is due", async () => {
    const h = harness();
    h.narrator.begin();
    h.narrator.spoke("agent", "Your invoice is in the shared folder.");
    await h.advance(NARRATION_SILENCE_MS + NARRATION_OPENING_ALLOWANCE_MS);
    expect(h.delivered).toEqual([]);
    expect(h.calls()).toBe(0);
  });

  test("stays silent while tools finish inside three seconds", async () => {
    const h = harness();
    h.narrator.spoke("agent", "Sure.");
    h.narrator.toolStarted("Shell");
    await h.advance(NARRATION_SILENCE_MS - 500);
    expect(h.calls()).toBe(0);
    expect(h.delivered).toEqual([]);
  });

  test("narrates once silence passes three seconds, counted from the end of the last line", async () => {
    const h = harness(["I'm still searching."]);
    h.narrator.spoke("agent", "Sure.");
    h.narrator.toolStarted("WebSearch");
    await h.advance(NARRATION_SILENCE_MS);
    expect(h.delivered).toEqual([]);
    await h.advance(2_000);
    expect(h.delivered).toEqual(["I'm still searching."]);
  });

  test("does not start a countdown for the agent's own SendToUser call", async () => {
    const h = harness();
    h.narrator.toolStarted("SendToUser");
    await h.advance(10_000);
    expect(h.calls()).toBe(0);
  });

  test("never narrates after stop", async () => {
    const h = harness();
    h.narrator.begin();
    h.narrator.stop();
    await h.advance(20_000);
    expect(h.calls()).toBe(0);
  });

  test("caps the number of narrations in one turn", async () => {
    const h = harness(["One.", "Two.", "Three.", "Four.", "Five.", "Six.", "Seven."]);
    h.narrator.begin();
    h.narrator.toolStarted("Shell");
    await h.advance(120_000);
    expect(h.delivered.length).toBe(5);
  });
});

describe("voice narrator awareness", () => {
  test("the narration prompt includes what the agent already said", async () => {
    const h = harness(["I'm checking."]);
    h.narrator.spoke("agent", "Let me pull up the invoice.");
    h.narrator.toolStarted("Read");
    await h.advance(6_000);
    expect(h.prompts.at(-1)).toContain("Assistant: Let me pull up the invoice.");
  });

  test("a later narration sees the earlier one", async () => {
    const h = harness(["I'm opening the file.", "Still working on it."]);
    h.narrator.begin();
    h.narrator.toolStarted("Read");
    await h.advance(15_000);
    expect(h.prompts[1]).toContain("Narrator: I'm opening the file.");
  });

  test("the agent is told what was already spoken", () => {
    const log = new SaidLog();
    expect(log.forAgent()).toBeNull();
    log.add("narrator", "I'm checking your calendar.");
    log.add("agent", "Found two meetings.");
    const reminder = log.forAgent()!;
    expect(reminder).toContain("Voice narrator: I'm checking your calendar.");
    expect(reminder).toContain("You: Found two meetings.");
    expect(reminder).toContain("Do not repeat it");
  });

  test("version changes only when something new is said", () => {
    const log = new SaidLog();
    log.add("agent", "   ");
    expect(log.version).toBe(0);
    log.add("agent", "Hello.");
    expect(log.version).toBe(1);
  });
});

describe("narration safety", () => {
  test("describes tools with fixed phrases, never their arguments", () => {
    expect(describeAction("Shell")).toBe("running a command");
    expect(describeAction("SomethingNew")).toBe("working on it");
    expect(describeAction("SendToUser")).toBeNull();
  });

  test("the prompt carries the action label but nothing else about the tool", () => {
    const prompt = narrationPrompt({
      userRequest: "hi",
      action: describeAction("Shell"),
      said: [],
    });
    expect(prompt).toContain("running a command");
    expect(prompt).not.toContain("Shell");
  });

  test("cleans markdown and rejects runaway output", () => {
    expect(cleanNarration('  "**I\'m checking** that now." ')).toBe("I'm checking that now.");
    expect(cleanNarration("")).toBeNull();
    expect(cleanNarration("x".repeat(500))).toBeNull();
  });
});
