import { describe, expect, test } from "bun:test";
import { searchFailureMessage } from "../src/search-error";

describe("mobile search error copy", () => {
  test("turns native network failures into useful connection guidance", () => {
    expect(
      searchFailureMessage(
        new Error(
          "fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)"
        )
      )
    ).toBe("OpenTeam couldn't reach your server. Check the connection and try again.");
  });

  test("does not expose unknown server or implementation details", () => {
    expect(searchFailureMessage(new Error("SQLSTATE 53300 at internal-search.ts:42"))).toBe(
      "Search couldn't be completed. Try again."
    );
    expect(searchFailureMessage({ secret: "do not render" })).toBe(
      "Search couldn't be completed. Try again."
    );
  });
});
