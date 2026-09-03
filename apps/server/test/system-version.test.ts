import { describe, expect, test } from "bun:test";
import { OPENTEAM_API_PROTOCOL_VERSION, systemVersion } from "../src/system-version";

describe("system version metadata", () => {
  test("allows compatible patch clients in the same release line by default", () => {
    expect(systemVersion({ OPENTEAM_VERSION: "1.4.2" })).toEqual({
      releaseVersion: "1.4.2",
      apiProtocolVersion: OPENTEAM_API_PROTOCOL_VERSION,
      minimumClientVersion: "1.4.0",
      maximumClientVersionExclusive: "1.5.0",
      recommendedClientVersion: "1.4.2",
      updateChannel: "stable",
    });
  });

  test("accepts explicit compatibility boundaries and rejects malformed values", () => {
    expect(
      systemVersion({
        OPENTEAM_VERSION: "2.0.0",
        OPENTEAM_MIN_CLIENT_VERSION: "1.9.0",
        OPENTEAM_MAX_CLIENT_VERSION_EXCLUSIVE: "2.1.0",
        OPENTEAM_RECOMMENDED_CLIENT_VERSION: "2.0.0",
        OPENTEAM_UPDATE_CHANNEL: "beta",
      })
    ).toMatchObject({
      minimumClientVersion: "1.9.0",
      maximumClientVersionExclusive: "2.1.0",
      recommendedClientVersion: "2.0.0",
      updateChannel: "beta",
    });
    expect(systemVersion({ OPENTEAM_VERSION: "latest" }).releaseVersion).toBe("0.1.0");
  });
});
