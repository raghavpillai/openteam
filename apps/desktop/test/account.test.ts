import { describe, expect, test } from "bun:test";
import { accountPresentation } from "../src/renderer/lib/account";

describe("authenticated account presentation", () => {
  test("shows the username as it was typed; the login form is lowercase", () => {
    expect(
      accountPresentation(
        {
          id: "owner-1",
          name: "Raghav-P",
          email: "raghav-p@openteam.invalid",
          username: "raghav-p",
          image: null,
        },
        "required"
      )
    ).toEqual({
      name: "Raghav-P",
      detail: "Username and password",
      initials: "RA",
      copyValue: "raghav-p",
    });
  });

  test("describes deployments where authentication is disabled", () => {
    expect(accountPresentation(null, "disabled")).toEqual({
      name: "Account",
      detail: "No sign-in required",
      initials: "OT",
      copyValue: null,
    });
  });
});
