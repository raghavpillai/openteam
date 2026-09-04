import { describe, expect, test } from "bun:test";
import {
  CHANNEL_UPDATE_NEEDS_MEMBER,
  CHANNEL_UPDATE_NOTHING_TO_CHANGE,
  channelNotFoundMessage,
  nextChannelMemberIds,
} from "../../src/services/administration-service";

describe("Grok-compatible channel administration", () => {
  test("keeps the exact no-op, empty-roster, and not-found results", () => {
    expect(CHANNEL_UPDATE_NOTHING_TO_CHANGE).toBe(
      "Nothing to change: provide add_member_ids and/or remove_member_ids."
    );
    expect(CHANNEL_UPDATE_NEEDS_MEMBER).toBe(
      "A channel needs at least one member, so this removal was not applied."
    );
    expect(channelNotFoundMessage("group-1")).toBe("No channel found with id group-1.");
  });

  test("updates atomically with remove-wins ordering and the six-member cap", () => {
    expect(
      nextChannelMemberIds({
        current: ["one", "two"],
        validAdds: ["two", "three", "one"],
        removes: ["one"],
      })
    ).toEqual(["two", "three"]);
    expect(
      nextChannelMemberIds({
        current: ["one", "two"],
        validAdds: ["three", "four", "five", "six", "seven"],
        removes: [],
      })
    ).toEqual(["one", "two", "three", "four", "five", "six"]);
  });
});
