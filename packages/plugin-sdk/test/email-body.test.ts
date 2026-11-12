import { expect, test } from "bun:test";
import { emailBodyHtmlTag, unwrapHardWrappedEmailBody } from "../src/email-body";
// Inputs and the reference implementation's outputs for them (10-20 build).
import cases from "./email-body.cases.json";

test("hard-wrapped bodies unwrap exactly like the reference", () => {
  for (const { body, expected } of cases.unwrap) expect(unwrapHardWrappedEmailBody(body)).toBe(expected);
});

test("HTML closing tags and line breaks are found; bare angle brackets are not", () => {
  for (const { body, expected } of cases.htmlTag) expect(emailBodyHtmlTag(body) ?? null).toBe(expected);
});
