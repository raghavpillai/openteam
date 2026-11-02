import { expect, test } from "bun:test";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { repairImageHistory } from "../src/runtime/image-input";

const Jimp = createJimp({ formats: [png] });
const fixture = async () => {
  const bytes = await new Jimp({ width: 24, height: 16, color: 0x3579bdff }).getBuffer("image/png");
  return { type: "image", data: bytes.toString("base64"), mimeType: "image/png" };
};

test("concurrent history repair preserves ordering, notices, cache identity, and receipt isolation", async () => {
  const image = await fixture();
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: "toolResult",
    toolName: "Computer",
    index,
    content: [
      { type: "text", text: `receipt-${index}` },
      { ...image },
      { type: "image", data: "invalid-image", mimeType: "image/png" },
      { ...image },
    ],
  }));
  const original = JSON.stringify(messages);
  const [first, second] = await Promise.all([
    repairImageHistory(messages),
    repairImageHistory(messages),
  ]);
  expect(first.map((message) => message.index)).toEqual(messages.map((message) => message.index));
  for (let index = 0; index < messages.length; index++) {
    const result = first[index]!;
    expect(second[index]).toBe(result);
    expect(result).not.toBe(messages[index]);
    expect(result.content[0]).toEqual({ type: "text", text: `receipt-${index}` });
    expect(result.content[1]).toEqual(image);
    expect(result.content[2]).toMatchObject({ type: "text" });
    expect(result.content[3]).toEqual(image);
    expect(result.content[1]).not.toBe(messages[index]!.content[1]);
  }
  expect(JSON.stringify(messages)).toBe(original);
  const repairedImage = first[0]!.content[1]!;
  const receiptImage = messages[0]!.content[1]!;
  if (!("data" in repairedImage) || !("data" in receiptImage)) throw new Error("Missing image");
  repairedImage.data = "changed output";
  expect(receiptImage.data).toBe(image.data);
});

test("a rejected history input releases the validation slot for later callers", async () => {
  const invalid = () => ({
    role: "toolResult",
    toolName: "Computer",
    content: [{ type: "image", data: undefined, mimeType: "image/png" }],
  });
  await Promise.all([
    expect(repairImageHistory([invalid()])).rejects.toThrow(),
    expect(repairImageHistory([invalid()])).rejects.toThrow(),
  ]);
  const image = await fixture();
  const input = { role: "toolResult", toolName: "Computer", content: [image] };
  const [result] = await repairImageHistory([input]);
  expect(result!.content[0]).toEqual(image);
});
