import { expect, test } from "bun:test";
import type { OpenTeamAuthUser } from "@openteam/client-core/auth";
import { accountInitials, accountName } from "../src/account-display";
const user = (fields: Partial<OpenTeamAuthUser>) => ({ id: "test", ...fields }) as OpenTeamAuthUser;

test("shows the username and its first two letters instead of name initials", () => {
  const owner = user({ name: "Raghav Pillai", username: "raghav" });
  expect(accountName(owner)).toBe("raghav");
  expect(accountInitials(owner)).toBe("RA");
  expect(accountInitials(user({ name: "  ", username: "alice" }))).toBe("AL");
  expect(accountInitials(user({ email: "private@example.test" }))).toBe("OT");
  expect(accountInitials(null)).toBe("OT");
});

test("initials handle whitespace and names outside ASCII", () => {
  expect(accountInitials(user({ name: "  Maria   del Mar " }))).toBe("MA");
  expect(accountInitials(user({ username: "李小龍" }))).toBe("李小");
  expect(accountInitials(user({ username: "a" }))).toBe("A");
});
