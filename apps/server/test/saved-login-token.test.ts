import { expect, test } from "bun:test";
import { SavedLoginTokenCipher } from "../src/services/saved-login-token";
const token = "ops_synthetic_private_token";
const cipher = new SavedLoginTokenCipher(() => "synthetic-test-deployment-secret-32-characters");
test("saved-login envelopes hide credentials and bind ciphertext to the connection and deployment", () => {
  const encrypted = cipher.encrypt(token, "connection");
  expect(encrypted).toStartWith("enc:v1:");
  expect(encrypted).not.toContain(token);
  expect(cipher.decrypt(encrypted, "connection")).toBe(token);
  expect(cipher.encrypt(token, "connection")).not.toBe(encrypted);
  expect(() => cipher.decrypt(encrypted, "another-connection")).toThrow("Reconnect");
  expect(() => new SavedLoginTokenCipher(() => "another-deployment-secret-32-characters").decrypt(encrypted, "connection")).toThrow("Reconnect");
  const bytes = Buffer.from(encrypted.slice(7), "base64");
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  expect(() => cipher.decrypt(`enc:v1:${bytes.toString("base64")}`, "connection")).toThrow("Reconnect");
  expect(() => cipher.decrypt(token, "connection")).toThrow("Reconnect");
  expect(() => new SavedLoginTokenCipher(() => undefined).encrypt(token, "connection")).toThrow("OPENTEAM_AUTH_SECRET");
});
