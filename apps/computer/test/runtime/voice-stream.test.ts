import { describe, expect, test } from "bun:test";
import { SendToUserSpeech, sentenceEnd } from "../../src/runtime/voice-stream";

const speech = () => {
  const sent: Array<[string, string]> = [];
  const instance = new SendToUserSpeech(async (callId, text) => void sent.push([callId, text]));
  return { instance, sent };
};

describe("sentence boundaries in a partial message", () => {
  test("nothing is spoken until a sentence is complete", () => {
    expect(sentenceEnd("我先帮你看一下现在", 0)).toBe(0);
    expect(sentenceEnd("Let me check that for", 0)).toBe(0);
  });
  test("a Chinese stop ends a sentence", () => {
    expect(sentenceEnd("我先帮你看一下。然后", 0)).toBe(8);
  });
  test("a Latin stop at the very end waits, since it may be part of a number", () => {
    expect(sentenceEnd("The value is 3.", 0)).toBe(0);
    expect(sentenceEnd("The value is 3.5 today. Next", 0)).toBe("The value is 3.5 today.".length);
  });
  test("a very short sentence is held back and joins the next one", () => {
    expect(sentenceEnd("好。我来查一下。", 0)).toBe(8);
  });
  test("continues from where the last chunk ended", () => {
    expect(sentenceEnd("第一句话说完了。第二句也说完了。尾", 8)).toBe(16);
  });
});

describe("SendToUser speech streaming", () => {
  test("sends each finished sentence once, in order", async () => {
    const { instance, sent } = speech();
    instance.observe("c1", { type: "text", content: "我先帮你看一下" });
    instance.observe("c1", { type: "text", content: "我先帮你看一下天气。再等" });
    instance.observe("c1", { type: "text", content: "我先帮你看一下天气。再等我一下，马上就好。" });
    await instance.flush();
    expect(sent).toEqual([
      ["c1", "我先帮你看一下天气。"],
      ["c1", "再等我一下，马上就好。"],
    ]);
    expect(instance.emittedChars("c1")).toBe(21);
  });

  test("ignores messages that are not plain text to the user's own chat", async () => {
    const { instance, sent } = speech();
    instance.observe("a", { type: "widget", content: "这是一个很长的句子需要读完。" });
    instance.observe("b", { type: "text", content: "发给房间的消息会很长很长。", to: "dm" });
    instance.observe("c", { type: "text", content: "发给别的渠道的消息很长很长。", channel: "x" });
    await instance.flush();
    expect(sent).toEqual([]);
  });

  test("does not read out an open code block", async () => {
    const { instance, sent } = speech();
    instance.observe("c1", { type: "text", content: "代码如下。```ts\nconst a = 1;\n" });
    await instance.flush();
    expect(sent).toEqual([]);
  });

  test("a failed chunk stops streaming for that call only", async () => {
    const sent: string[] = [];
    const instance = new SendToUserSpeech(async (callId, text) => {
      if (callId === "bad") throw new Error("down");
      sent.push(text);
    });
    instance.observe("bad", { type: "text", content: "第一句话说完了。" });
    await instance.flush();
    instance.observe("bad", { type: "text", content: "第一句话说完了。第二句话说完了。" });
    instance.observe("good", { type: "text", content: "另一条消息说完了。" });
    await instance.flush();
    expect(sent).toEqual(["另一条消息说完了。"]);
  });
});
