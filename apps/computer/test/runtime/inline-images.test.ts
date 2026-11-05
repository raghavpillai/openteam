import { expect, test } from "bun:test";
import { decodeInlineImages } from "../../src/runtime";

const PNG_BYTES = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4////fwAJ+wP92PZgeAAAAABJRU5ErkJggg==";

test("decodes inline uploads as structured Pi image content", () => {
  expect(decodeInlineImages([{ url: `data:image/png;base64,${PNG_BYTES}` }])).toEqual([
    { type: "image", data: PNG_BYTES, mimeType: "image/png" },
  ]);
  expect(() => decodeInlineImages([{ url: "data:image/png;base64,not-base64" }])).toThrow("invalid base64 data");
});
