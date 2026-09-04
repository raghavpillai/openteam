import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { Metadata, MetadataKind } from "@tufjs/models";
import { needsCryptoVerifyCompatibility } from "../src/bun-crypto";
import { installCryptoVerifyDefaults } from "../src/runtime-compat";

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(fixture(path), "utf8"));

// Bun and Electron use BoringSSL-backed crypto.verify implementations without Node's
// default digest behavior. These tests run under Bun and exercise the same compatibility
// path used by the Electron-bundled CLI.
describe("crypto.verify default digest under BoringSSL runtimes", () => {
  test("enables compatibility for Bun and Electron, but not standard Node", () => {
    expect(needsCryptoVerifyCompatibility({ bun: "1.3.8" })).toBe(true);
    expect(needsCryptoVerifyCompatibility({ electron: "43.4.1" })).toBe(true);
    expect(needsCryptoVerifyCompatibility({ node: "24.13.1" })).toBe(false);
  });

  test("the shim is installed once", () => {
    expect(installCryptoVerifyDefaults()).toBe(true);
    expect((crypto.verify as { openteamPatched?: boolean }).openteamPatched).toBe(true);
  });

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

  test("leaves Ed25519 keys without a digest", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const data = Buffer.from("release bundle");
    const signature = crypto.sign(null, data, privateKey);
    expect(crypto.verify(undefined, data, publicKey, signature)).toBe(true);
  });

  test("verifies the Sigstore TUF root signatures", () => {
    const root = readJson("sigstore-tuf-cache/root.json");
    const metadata = Metadata.fromJSON(MetadataKind.Root, root);
    expect(() => metadata.verifyDelegate("root", metadata)).not.toThrow();
    expect(root.signatures.length).toBeGreaterThanOrEqual(root.signed.roles.root.threshold);
  });

  test("verifies a captured release bundle against the Sigstore trust root", () => {
    const trustedRoot = TrustedRoot.fromJSON(
      readJson("sigstore-tuf-cache/targets/trusted_root.json")
    );
    const verifier = new Verifier(toTrustMaterial(trustedRoot), {
      ctlogThreshold: 1,
      tlogThreshold: 1,
    });
    const bundle = bundleFromJSON(readJson("release-v0.1.0/openteam-compose.yaml.sigstore.json"));
    const artifact = readFileSync(fixture("release-v0.1.0/openteam-compose.yaml"));
    const identity =
      "https://github.com/raghavpillai/openteam/.github/workflows/release.yml@refs/tags/v0.1.0";
    expect(() =>
      verifier.verify(toSignedEntity(bundle, artifact), {
        subjectAlternativeName: `^${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        extensions: { issuer: "https://token.actions.githubusercontent.com" },
      })
    ).not.toThrow();
    expect(() =>
      verifier.verify(toSignedEntity(bundle, Buffer.concat([artifact, Buffer.from("\n#")])), {
        extensions: { issuer: "https://token.actions.githubusercontent.com" },
      })
    ).toThrow();
  });
});
