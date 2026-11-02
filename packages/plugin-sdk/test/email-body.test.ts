import { expect, test } from "bun:test";
import { emailBodyHtmlTag, unwrapHardWrappedEmailBody } from "../src/email-body";
// Inputs and the reference implementation's outputs for them (10-20 build).
import cases from "./email-body.cases.json";

test("hard-wrapped bodies unwrap exactly like the reference", () => {
  for (const { body, expected } of cases.unwrap) expect(unwrapHardWrappedEmailBody(body)).toBe(expected);
  expect(cases.unwrap.filter(({ body, expected }) => body !== expected).length).toBe(11);
});

test("prose wrapped at about 72 columns becomes one line per paragraph; greeting and sign-off stay", () => {
  const body = [
    "Hi Dana,",
    "",
    "Thanks for sending over the revised proposal yesterday. I went through",
    "the pricing section with the team this morning and we are aligned on",
    "the overall structure, but we would like to revisit the onboarding fee",
    "before we sign.",
    "",
    "Best,",
    "Raghav",
  ].join("\n");
  expect(unwrapHardWrappedEmailBody(body).split("\n")).toEqual([
    "Hi Dana,",
    "",
    "Thanks for sending over the revised proposal yesterday. I went through the pricing section with the team this morning and we are aligned on the overall structure, but we would like to revisit the onboarding fee before we sign.",
    "",
    "Best,",
    "Raghav",
  ]);
});

test("a body with nothing to join comes back unchanged, line endings included", () => {
  const body = "Hi,\r\n\r\nSee you at 3.\r\nThanks!\r\nR";
  expect(unwrapHardWrappedEmailBody(body)).toBe(body);
});

test("HTML closing tags and line breaks are found; bare angle brackets are not", () => {
  for (const { body, expected } of cases.htmlTag) expect(emailBodyHtmlTag(body) ?? null).toBe(expected);
});
