import { expect, test } from "bun:test";
import { draftNotificationVariant, DRAFT_NOTIFICATION_COLLECTION_MS } from "../src/draft-notifications";

test("draft notification A/B defaults to control and validates an opt-in percentage", () => {
  for (const value of ["0", "invalid", "-1", "101", "Infinity"]) expect(draftNotificationVariant("bot", value)).toBe("control");
  expect(draftNotificationVariant("bot", "100")).toBe("treatment");
  expect(DRAFT_NOTIFICATION_COLLECTION_MS).toBeLessThanOrEqual(1000);
});

test("A/B assignment is deterministic by bot and independent of run or card identity", () => {
  const bots = Array.from({ length: 100 }, (_, i) => `bot-${i}`);
  const assignments = bots.map(bot => draftNotificationVariant(bot, "50"));
  expect(bots.map(bot => draftNotificationVariant(bot, "50"))).toEqual(assignments);
  expect(new Set(assignments)).toEqual(new Set(["control", "treatment"]));
  for (const [i, bot] of bots.entries()) if (assignments[i] === "treatment") expect(draftNotificationVariant(bot, "75")).toBe("treatment");
});
