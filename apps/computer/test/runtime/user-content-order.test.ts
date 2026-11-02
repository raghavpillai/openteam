import { expect, test } from "bun:test";
import { imagesBeforeText } from "../../src/runtime/user-content-order";

test("a user's images go ahead of their words, as in the reference", () => {
  const text = { type: "text", text: "<user_query>hi</user_query>" };
  const first = { type: "image", data: "a", mimeType: "image/png" };
  const second = { type: "image", data: "b", mimeType: "image/png" };
  const stored = { role: "user", content: [text, first, second] };
  const [sent] = imagesBeforeText([stored]);
  expect(sent!.content).toEqual([first, second, text]);
  expect(stored.content).toEqual([text, first, second]);
});

test("other messages and image-free prompts pass through as they are", () => {
  const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "image", data: "a" }] };
  const plain = { role: "user", content: [{ type: "text", text: "hi" }] };
  const ordered = { role: "user", content: [{ type: "image", data: "a" }, { type: "text", text: "hi" }] };
  const messages = [assistant, plain, ordered];
  expect(imagesBeforeText(messages).every((message, index) => message === messages[index])).toBe(true);
});
