import { expect, test } from "bun:test";
import { validateMessagesSendFiles, MESSAGES_SEND_MAX_BYTES } from "../src/messages-send";

test("private attachment payloads enforce safe filenames, base64 and a combined byte budget", () => {
  const file = { fileName: "report.pdf", bytesBase64: Buffer.from("%PDF-1.7\nfixture").toString("base64") };
  expect(validateMessagesSendFiles([file])).toEqual([file]);
  expect(validateMessagesSendFiles(undefined)).toEqual([]);
  for (const files of [[], Array(11).fill(file), [{ ...file, fileName: "../secret" }], [{ ...file, fileName: "a\\b" }], [{ ...file, fileName: "a\n.pdf" }], [{ ...file, bytesBase64: "!!!!" }], [{ ...file, bytesBase64: "abc" }], [null]])
    expect(() => validateMessagesSendFiles(files)).toThrow();
  // Exercise a real maximum-size base64 string, including its final padded quantum.
  const full = { ...file, bytesBase64: Buffer.alloc(MESSAGES_SEND_MAX_BYTES).toString("base64") };
  expect(validateMessagesSendFiles([full])).toHaveLength(1);
  expect(() => validateMessagesSendFiles([full, file])).toThrow("25 MiB");
});
