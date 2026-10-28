import { expect, test } from "bun:test";
import { customerDecision } from "./customer-policy";
const scope = { question: "May I confirm the requested workflow?", readonly: false, cancelled: false, additionalFee: 0, materialChange: false };
test("the customer can approve an explicitly zero-cost form without broadening the budget", () => {
  expect(customerDecision({ ...scope, question: "May I accept the $0.00 confirmation?", options: ["I authorize accepting the $0.00 charge to finish", "Do not accept"] })).toMatchObject({ denied: false, value: "I authorize accepting the $0.00 charge to finish" });
  for (const question of ["May I accept $35?", "May I pay €12.50?", "May I pay £5?"]) expect(customerDecision({ ...scope, question, options: ["Yes", "No"] })).toMatchObject({ denied: true, value: "No" });
});
test("read-only, cancellation, provider fees and changed terms override affirmative options", () => {
  for (const change of [{ readonly: true }, { cancelled: true }, { additionalFee: 35 }, { materialChange: true }]) {
    expect(customerDecision({ ...scope, ...change, options: ["Yes, continue", "I decline"] })).toMatchObject({ denied: true, value: "I decline" });
  }
});
test("unknown option wording gets a scoped text reply instead of selecting the first option", () => {
  const result = customerDecision({ ...scope, options: ["Do something unspecified"] });
  expect(result.value).toBeUndefined(); expect(result.text).toContain("No nonzero fee");
});
