import { expect, test } from "bun:test";
import { createToolValidator } from "../src/json-schema";

test("tool byte fields accept large valid attachments and reject malformed base64", () => {
  const validate = createToolValidator({ type: "object", properties: { content: { type: "string", format: "byte" }, date: { type: "string", format: "date-time" } }, required: ["content"], additionalProperties: false });
  expect(validate({ content: Buffer.alloc(9 * 1024 * 1024, 42).toString("base64") }).valid).toBe(true);
  for (const content of ["A", "AAA", "AA=A", "A===", "A_AA", "AA==\n", "?AAA"]) expect(validate({content}).valid).toBe(false);
  expect(validate({content:"AA==", date:"not-a-date"}).valid).toBe(false);
  expect(validate({content:"AA==", extra:true}).valid).toBe(false);
});
