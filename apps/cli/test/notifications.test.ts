import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "../src/arguments";
import { readApnsConfiguration } from "../src/notifications";

const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const metadata = { keyId: "ABCDE12345", teamId: "FGHIJ67890", topic: "dev.openbot.mobile" };
describe("APNs configuration import", () => {
  test("rejects ambiguous imports, unknown fields, malformed JSON and oversized files without exposing contents", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-apns-invalid-"));
    const path = join(directory, "apns.json");
    const options = parseArguments(["notifications", "configure", "--config", path]);
    try {
      writeFileSync(
        path,
        JSON.stringify({ ...metadata, privateKey, privateKeyFile: "secret-key-path" })
      );
      expect(() => readApnsConfiguration(options)).toThrow("Choose one");
      expect(() => readApnsConfiguration({ ...options, apnsKeyFile: "key.p8" })).toThrow(
        "Choose --config"
      );
      writeFileSync(
        path,
        JSON.stringify({ ...metadata, privateKey, secretUnknownField: "secret-value" })
      );
      expect(() => readApnsConfiguration(options)).toThrow("Unknown APNs configuration field");
      writeFileSync(path, "{secret-value");
      expect(() => readApnsConfiguration(options)).toThrow(
        "Could not read valid APNs configuration JSON"
      );
      writeFileSync(path, "secret-value".repeat(4000));
      expect(() => readApnsConfiguration(options)).toThrow(
        "Could not read valid APNs configuration JSON"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
