import { describe, expect, test } from "bun:test";
import { accountPresentation } from "../src/renderer/lib/account";

describe("authenticated account presentation", () => {
  test("uses the owner returned by the login session", () => {
    expect(
      accountPresentation(
        {
          id: "owner-1",
          name: "raghav",
          email: "raghav@openbot.invalid",
          username: "raghav",
          image: null,
        },
        "required"
      )
    ).toEqual({
      name: "raghav",
      detail: "@raghav",
      initials: "RA",
      copyValue: "raghav",
    });
  });

  test("describes deployments where authentication is disabled", () => {
    expect(accountPresentation(null, "disabled")).toEqual({
      name: "OpenBot owner",
      detail: "Authentication disabled",
      initials: "OB",
      copyValue: null,
    });
  });
});
