import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { Metadata, MetadataKind } from "@tufjs/models";
import { installCryptoVerifyDefaults } from "../src/runtime-compat";

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(fixture(path), "utf8"));

// Bun's crypto.verify has no default digest for EC and RSA keys, while Node uses SHA-256.
// The Sigstore and TUF libraries omit the digest in several places, so a compiled CLI
// rejected every valid release with "root was signed by 0/3 keys". These tests run under
// Bun and exercise the same code paths the installer uses.
describe("crypto.verify default digest under Bun", () => {
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
