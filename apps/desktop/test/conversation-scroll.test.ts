import { describe, expect, test } from "bun:test";
import { appendedTimelineEntryCount } from "../src/renderer/components/ai-elements/conversation";

describe("conversation new-message notices", () => {
  test("does not count cursor-paginated history as new", () => {
    expect(
      appendedTimelineEntryCount({
        previousCount: 200,
        nextCount: 300,
        previousLatestKey: "message:newest",
        nextLatestKey: "message:newest",
      })
    ).toBe(0);
  });

  test("counts appended and replaced tails", () => {
    expect(
      appendedTimelineEntryCount({
        previousCount: 200,
        nextCount: 203,
        previousLatestKey: "message:old",
        nextLatestKey: "message:new",
      })
    ).toBe(3);
    expect(
      appendedTimelineEntryCount({
        previousCount: 200,
        nextCount: 200,
        previousLatestKey: "approval:old",
        nextLatestKey: "message:new",
      })
    ).toBe(1);
  });
});
