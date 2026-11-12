import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { Metadata, MetadataKind } from "@tufjs/models";
import "../src/runtime-compat";

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(fixture(path), "utf8"));

// Bun and Electron use BoringSSL-backed crypto.verify implementations without Node's
// default digest behavior. These tests run under Bun and exercise the same compatibility
// path used by the Electron-bundled CLI.
describe("crypto.verify default digest under BoringSSL runtimes", () => {
  test("verifies EC and RSA signatures without an explicit digest, like Node", () => {
    const data = Buffer.from("release bundle");
    for (const [type, options] of [
      ["ec", { namedCurve: "P-256" }],
      ["rsa", { modulusLength: 2048 }],
    ] as const) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync(type as "ec", options as never);
      const signature = crypto.sign("sha256", data, privateKey);
      expect(crypto.verify(undefined, data, publicKey, signature)).toBe(true);
      expect(crypto.verify(null, data, publicKey, signature)).toBe(true);
      expect(crypto.verify(undefined, Buffer.from("tampered"), publicKey, signature)).toBe(false);
    }
  });

  test("verifies the Sigstore TUF root signatures", () => {
    const root = readJson("sigstore-tuf-cache/root.json");
    const metadata = Metadata.fromJSON(MetadataKind.Root, root);
    expect(() => metadata.verifyDelegate("root", metadata)).not.toThrow();
    expect(root.signatures.length).toBeGreaterThanOrEqual(root.signed.roles.root.threshold);
  });
});
