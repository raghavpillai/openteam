import { expect, test } from "bun:test";
import { validateOwnerUsername } from "../src/setup-values";

// The server checks the same rules (apps/server/test/auth/username.test.ts).
test("usernames keep their case and allow dashes, underscores and dots between characters", () => {
  for (const name of ["sam", "Raghav", "raghav-pillai", "Team_Bot.2", "a1b", "x".repeat(30)]) {
    expect(validateOwnerUsername(name)).toBe(name);
  }
  expect(validateOwnerUsername("  Raghav-P  ")).toBe("Raghav-P");
});

test("each broken username says what to change", () => {
  const problem = (value: string) => {
    try {
      validateOwnerUsername(value);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };
  expect(problem("")).toBe("Enter a username.");
  expect(problem("raghav pillai")).toBe("Usernames can't contain spaces.");
  expect(problem("sam@home")).toBe(
    '"@" isn\'t allowed. Use letters, numbers, dashes, underscores, or dots.'
  );
  expect(problem("ab")).toBe("Use 3 to 30 characters.");
  expect(problem("-sam")).toBe("Start and end with a letter or number.");
  expect(problem("sam.")).toBe("Start and end with a letter or number.");
  expect(problem("sam--bot")).toBe("Use one dash, underscore, or dot at a time.");
});
