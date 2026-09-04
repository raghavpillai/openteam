import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { withBunCryptoVerifyCompatibility } from "../src/bun-crypto";

describe("Bun signature verification compatibility", () => {
  test("selects SHA-256 for a TUF-style ECDSA verification with no digest", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const payload = Buffer.from("OpenTeam release metadata");
    const signature = crypto.sign("sha256", payload, privateKey);

    expect(
      await withBunCryptoVerifyCompatibility(async () =>
        crypto.verify(undefined as unknown as null, payload, { key: publicKey }, signature)
      )
    ).toBe(true);
  });
});
