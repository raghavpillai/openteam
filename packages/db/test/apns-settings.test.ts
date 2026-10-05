import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { PrismaClient } from "../src/generated/prisma/client";
import { ApnsSettingsStore, validateApnsConfiguration } from "../src/apns-settings";

const config = {
  keyId: "ABCDE12345",
  teamId: "FGHIJ67890",
  topic: "dev.openbot.mobile",
  privateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
};
const fixture = () => {
  let row: any = null;
  const prisma = {
    apnsSettings: {
      findUnique: async () => row,
      upsert: async ({ create, update }: any) =>
        (row = { ...(row ? { ...row, ...update } : create), updatedAt: new Date() }),
    },
  } as unknown as Pick<PrismaClient, "apnsSettings">;
  return { prisma, row: () => row };
};
describe("APNs runtime settings", () => {
  test("encrypts at rest, returns metadata only and authenticates metadata with the ciphertext", async () => {
    const fixtureData = fixture();
    const store = new ApnsSettingsStore(
      fixtureData.prisma,
      () => "test-installation-token-at-least-32-characters",
      () => config
    );
    const status = await store.save(config);
    expect(status).toMatchObject({ source: "database", issue: null, missing: [] });
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    expect(fixtureData.row().encryptedPrivateKey).toStartWith("enc:v1:");
    expect(JSON.stringify(fixtureData.row())).not.toContain(config.privateKey);
    expect((await store.load()).config).toEqual(config);
    fixtureData.row().topic = "dev.tampered.app";
    await expect(store.load()).rejects.toThrow("could not be decrypted or validated");
    expect(await store.status()).toMatchObject({ issue: "runtime-settings" });
  });
  test("a changed deployment secret fails closed instead of falling back to environment credentials", async () => {
    const { prisma } = fixture();
    let secret = "first-installation-token-at-least-32-characters";
    const store = new ApnsSettingsStore(
      prisma,
      () => secret,
      () => config
    );
    expect((await store.load()).source).toBe("environment");
    await store.save(config);
    secret = "second-installation-token-at-least-32-characters";
    await expect(store.load()).rejects.toThrow("import it again");
    await store.save(config);
    expect((await store.load()).config).toEqual(config);
  });
  test("refuses weak encryption secrets before persisting", async () => {
    const { prisma, row } = fixture();
    await expect(new ApnsSettingsStore(prisma, () => "short").save(config)).rejects.toThrow(
      "at least 32"
    );
    expect(row()).toBeNull();
  });
  test("rejects malformed IDs, topics and keys with safe error messages", () => {
    expect(() => validateApnsConfiguration({ ...config, keyId: "short" })).toThrow("10 uppercase");
    expect(() => validateApnsConfiguration({ ...config, topic: "invalid topic" })).toThrow(
      "app bundle ID"
    );
    expect(() =>
      validateApnsConfiguration({ ...config, privateKey: "secret-invalid-value" })
    ).toThrow("P-256");
    const wrongKey = generateKeyPairSync("ec", { namedCurve: "secp384r1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => validateApnsConfiguration({ ...config, privateKey: wrongKey })).toThrow("P-256");
  });
});
