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

  test("uses first and last initials for a full account name", () => {
    const account = accountPresentation(
      { id: "owner-2", name: "Raghav Pillai", email: "", username: "raghav", image: null },
      "required"
    );
    expect(account.name).toBe("Raghav Pillai");
    expect(account.initials).toBe("RP");
    expect(account.copyValue).toBe("raghav");
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
