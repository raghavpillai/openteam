import { expect, test } from "bun:test";
import { usernameKey, usernameProblem } from "../../src/username";

test("usernames allow either case, dashes, underscores and dots between letters and numbers", () => {
  for (const name of ["sam", "Raghav", "raghav-pillai", "Team_Bot.2", "a1b", "x".repeat(30)]) {
    expect(usernameProblem(name)).toBeNull();
  }
  expect(usernameProblem("  Raghav-P  ")).toBeNull();
});

test("each broken username says what to change", () => {
  expect(usernameProblem("")).toBe("Enter a username.");
  expect(usernameProblem("raghav pillai")).toBe("Usernames can't contain spaces.");
  expect(usernameProblem("sam@home")).toBe(
    '"@" isn\'t allowed. Use letters, numbers, dashes, underscores, or dots.'
  );
  expect(usernameProblem("ab")).toBe("Use 3 to 30 characters.");
  expect(usernameProblem("x".repeat(31))).toBe("Use 3 to 30 characters.");
  expect(usernameProblem("-sam")).toBe("Start and end with a letter or number.");
  expect(usernameProblem("sam.")).toBe("Start and end with a letter or number.");
  expect(usernameProblem("sam--bot")).toBe("Use one dash, underscore, or dot at a time.");
  expect(usernameProblem("sam._bot")).toBe("Use one dash, underscore, or dot at a time.");
});

test("sign-in matches a username in any case", () => {
  expect(usernameKey("  Raghav-P ")).toBe("raghav-p");
  expect(usernameKey("raghav-p")).toBe(usernameKey("RAGHAV-P"));
});
