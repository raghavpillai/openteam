import { test, expect } from "bun:test";
import { SecretRedactor, redactSecrets } from "../src/redaction";

test("redacts every byte split including UTF-8 and overlapping credentials", () => {
  const input = "before abcdef and abc and 🔒sécret after";
  for (let split = 0; split <= Buffer.byteLength(input); split++) {
    const bytes = Buffer.from(input);
    const redactor = new SecretRedactor(["abc", "abcdef", "🔒sécret"]);
    const output = Buffer.concat([
      redactor.write(bytes.subarray(0, split)),
      redactor.write(bytes.subarray(split)),
      redactor.end(),
    ]).toString();
    expect(output).toBe("before [REDACTED] and [REDACTED] and [REDACTED] after");
  }
  expect(redactSecrets('a\\n"b', ["a\n"])).toBe('[REDACTED]"b');
});
