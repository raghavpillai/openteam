import { describe, expect, test } from "bun:test";
import { ApiError } from "@openteam/contracts";
import { messageContextExtents } from "../src/message-context-query";

describe("message context query contract", () => {
  test("preserves the centered before/after request", () => {
    expect(messageContextExtents(new URLSearchParams())).toEqual({ before: 50, after: 50 });
    expect(messageContextExtents(new URLSearchParams("before=20&after=10"))).toEqual({
      before: 20,
      after: 10,
    });
  });

  test("maps directional pages to one side of the anchor", () => {
    expect(messageContextExtents(new URLSearchParams("direction=before&limit=25"))).toEqual({
      before: 25,
      after: 0,
    });
    expect(messageContextExtents(new URLSearchParams("direction=after&limit=30"))).toEqual({
      before: 0,
      after: 30,
    });
    expect(messageContextExtents(new URLSearchParams("direction=after"))).toEqual({
      before: 0,
      after: 50,
    });
  });

  test("rejects unknown or ambiguous directional requests", () => {
    for (const query of ["direction=sideways", "direction=before&before=10"]) {
      try {
        messageContextExtents(new URLSearchParams(query));
        throw new Error("expected context query to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(400);
      }
    }
  });
});
