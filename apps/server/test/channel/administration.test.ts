import { describe, expect, test } from "bun:test";
import { nextChannelMemberIds } from "../../src/services/administration-service";

describe("OpenTeam-compatible channel administration", () => {
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
