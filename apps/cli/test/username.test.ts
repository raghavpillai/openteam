import { expect, test } from "bun:test";
import { validateOwnerUsername } from "../src/setup-values";

// The server checks the same rules (apps/server/test/auth/username.test.ts).
test("owner usernames keep their case, trim whitespace, and reject unsafe shapes", () => {
  for (const name of ["sam", "Raghav", "raghav-pillai", "Team_Bot.2", "x".repeat(30)])
    expect(validateOwnerUsername(name)).toBe(name);
  expect(validateOwnerUsername("  Raghav-P  ")).toBe("Raghav-P");
  for (const bad of ["", "raghav pillai", "sam@home", "ab", "-sam", "sam.", "sam--bot"])
    expect(() => validateOwnerUsername(bad)).toThrow();
});
