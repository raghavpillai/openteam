import { describe, expect, test } from "bun:test";
import { errorMessage } from "../src/errors";

describe("CLI safe diagnostics", () => {
  test("never prints credentials carried by command failures", () => {
    const output = errorMessage(
      new Error("compose failed with OPENTEAM_POSTGRES_PASSWORD=database-secret")
    );
    expect(output).toBe("compose failed with OPENTEAM_POSTGRES_PASSWORD=[REDACTED]");
  });
});
