import { describe, expect, test } from "bun:test";
import {
  isSocialUtterance,
  openingLanguage,
  pickGreeting,
  pickOpening,
} from "../src/services/voice-opening";

const ANSWERING_LINES = {
  zh: ["在的，你说。", "我在，请讲。", "嗯，我在听。", "听得到，请说。"],
  en: ["I'm here, go ahead.", "Yes, I'm listening.", "I can hear you, go on.", "Hi, I'm here."],
};

describe("greetings and mic checks get a short reply, not 'let me look'", () => {
  test.each([
    "你好",
    "你好。",
    "对话测试。",
    "测试一下",
    "喂，你在吗？",
    "谢谢",
    "再见！",
    "Hello",
    "hi!",
    "Thank you.",
    "test",
    "OK",
  ])("%j is social", (text) => {
    expect(isSocialUtterance(text)).toBe(true);
    expect(ANSWERING_LINES.zh.concat(ANSWERING_LINES.en)).toContain(pickOpening(text, null));
  });

  test.each([
    "帮我查一下明天的天气",
    "你好，帮我查一下明天的天气",
    "Check my calendar for tomorrow",
    "what time is it",
  ])("%j is a real request", (text) => {
    expect(isSocialUtterance(text)).toBe(false);
    expect(ANSWERING_LINES.zh.concat(ANSWERING_LINES.en)).not.toContain(pickOpening(text, null));
  });
});

describe("fixed opening line", () => {
  test("follows the language of the request", () => {
    expect(openingLanguage("帮我订个会议室")).toBe("zh");
    expect(openingLanguage("book a meeting room")).toBe("en");
    expect(/[\p{Script=Han}]/u.test(pickOpening("帮我订个会议室", null))).toBe(true);
    expect(/[\p{Script=Han}]/u.test(pickOpening("book a meeting room", null))).toBe(false);
  });

  test("never repeats the previous line", () => {
    for (const text of ["帮我订个会议室", "你好", "book a meeting room"]) {
      let previous: string | null = null;
      for (let index = 0; index < 40; index += 1) {
        const next: string = pickOpening(text, previous, () => (index % 10) / 10);
        expect(next).not.toBe(previous);
        previous = next;
      }
    }
  });
});

describe("call greeting", () => {
  test("is chosen from the configured voice language", () => {
    expect(/[\p{Script=Han}]/u.test(pickGreeting("zh-CN"))).toBe(true);
    expect(/[\p{Script=Han}]/u.test(pickGreeting("en-US"))).toBe(false);
  });

  test("varies between calls", () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, index) => pickGreeting("zh-CN", () => (index % 10) / 10))
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});
