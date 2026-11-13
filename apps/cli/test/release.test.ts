import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Metadata, MetadataKind } from "@tufjs/models";
import { downloadRelease, verifyReleaseSignature } from "../src/release";
import "../src/runtime-compat";
import { RELEASE_COMPOSE, scratch } from "./fixtures/harness";

const s = scratch();
const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url);

test("rejects a Compose release whose checksum does not match", async () => {
  const origin = s.release(
    { "openteam-compose.yaml": RELEASE_COMPOSE },
    `${"0".repeat(64)}  openteam-compose.yaml\n`
  );
  await expect(
    downloadRelease({
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: `${origin}/openteam-compose.yaml`,
      checksumUrl: `${origin}/SHA256SUMS`,
      allowUnsigned: true,
    })
  ).rejects.toThrow("Checksum verification failed");
});

describe("local release signature trust", () => {
  const artifact = Bun.file(fixture("local-release-artifact.txt"));
  const signature = Bun.file(
    new URL("./fixtures/local-release-artifact.txt.sigstore.json", import.meta.url)
  );
  const options = async () => ({
    repository: "raghavpillai/openteam",
    version: "0.0.0",
    compose: await artifact.text(),
    serializedBundle: await signature.text(),
  });

  test("accepts the pinned local key with a verified transparency-log entry", async () => {
    await verifyReleaseSignature(await options());
  });
  test("rejects modified bytes, replay, untrusted keys, and missing transparency evidence", async () => {
    const original = await options();
    for (const changed of [
      { compose: original.compose + "tampered" },
      { version: "0.0.1" },
      { repository: "attacker/repo" },
    ])
      await expect(verifyReleaseSignature({ ...original, ...changed })).rejects.toThrow(
        "Sigstore verification failed"
      );
    const unknownKey = JSON.parse(original.serializedBundle);
    unknownKey.verificationMaterial.publicKey.hint = "untrusted-key";
    await expect(
      verifyReleaseSignature({ ...original, serializedBundle: JSON.stringify(unknownKey) })
    ).rejects.toThrow("Untrusted local release signing key");
    const unsignedLog = JSON.parse(original.serializedBundle);
    unsignedLog.verificationMaterial.tlogEntries = [];
    await expect(
      verifyReleaseSignature({ ...original, serializedBundle: JSON.stringify(unsignedLog) })
    ).rejects.toThrow("Sigstore verification failed");
  });
});

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
    const root = JSON.parse(readFileSync(fixture("sigstore-tuf-cache/root.json"), "utf8"));
    const metadata = Metadata.fromJSON(MetadataKind.Root, root);
    expect(() => metadata.verifyDelegate("root", metadata)).not.toThrow();
    expect(root.signatures.length).toBeGreaterThanOrEqual(root.signed.roles.root.threshold);
  });
});

describe("release Compose rendering", () => {
  test("replaces every OpenTeam tag with its immutable multi-architecture digest", async () => {
    const directory = s.dir("openteam-release-compose-");
    const digestDirectory = join(directory, "digests");
    mkdirSync(digestDirectory);
    const services = ["server", "worker", "migrate", "computer"];
    for (const [index, service] of services.entries()) {
      await Bun.write(
        join(digestDirectory, `openteam-${service}.digest`),
        `sha256:${String(index + 1).repeat(64)}\n`
      );
    }
    const output = join(directory, "openteam-compose.yaml");
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../../scripts/render-release-compose.ts"),
        resolve(import.meta.dir, "../../../deploy/compose.yaml"),
        output,
        digestDirectory,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(await child.exited).toBe(0);
    const rendered = await Bun.file(output).text();
    for (const [index, service] of services.entries()) {
      expect(rendered).toContain(`-${service}@sha256:${String(index + 1).repeat(64)}`);
    }
    expect(rendered.match(/-computer@sha256:4{64}/g)).toHaveLength(2);
    expect(rendered).toContain(
      "OPENTEAM_DESKTOP_MEMORY_LIMIT: ${OPENTEAM_DESKTOP_MEMORY_LIMIT:-10g}"
    );
    expect(rendered).toContain("mem_limit: ${OPENTEAM_COMPUTER_MEMORY_LIMIT:-12g}");
    expect(rendered).not.toMatch(
      /^\s*image:.*-(?:server|worker|migrate|computer):\$\{OPENTEAM_VERSION/m
    );
    const yaml = Bun.YAML.parse(rendered) as { services: Record<string, { logging: unknown }> };
    for (const service of Object.values(yaml.services)) {
      expect(service.logging).toEqual({
        driver: "json-file",
        options: {
          "max-size": "${OPENTEAM_LOG_MAX_SIZE:-10m}",
          "max-file": "${OPENTEAM_LOG_MAX_FILES:-3}",
        },
      });
    }
    expect(rendered).toContain('profiles: ["https"]');
    expect(rendered).toContain("caddy:2.11.4-alpine@sha256:");
    expect(rendered).toContain("${OPENTEAM_VIEWER_BIND_HOST:-127.0.0.1}:6200-6299");
    expect(rendered).toContain("OPENTEAM_AUTH_URL: ${OPENTEAM_AUTH_URL");
    const worker = rendered.split("  worker:")[1]!.split("\n  caddy:")[0]!;
    expect(worker).toContain("OPENTEAM_APNS_KEY_ID: ${OPENTEAM_APNS_KEY_ID:-}");
    expect(worker).toContain("OPENTEAM_APNS_TEAM_ID: ${OPENTEAM_APNS_TEAM_ID:-}");
    expect(worker).toContain("OPENTEAM_APNS_TOPIC: ${OPENTEAM_APNS_TOPIC:-dev.openbot.mobile}");
    expect(worker).toContain("OPENTEAM_APNS_PRIVATE_KEY: ${OPENTEAM_APNS_PRIVATE_KEY:-}");
    // Longer than pg-boss's 30 s graceful stop, so stopping never kills the worker.
    expect(worker).toContain("stop_grace_period: 45s");
    expect(rendered).not.toContain("OPENTEAM_WEB_SEARCH_");
    expect(rendered).not.toContain("OPENTEAM_PI_PROVIDER");
    expect(rendered).not.toContain("OPENTEAM_PI_MODEL");
    expect(rendered).not.toContain("OPENTEAM_PI_THINKING");
    expect(rendered).toContain('cap_add: ["ALL"]');
    expect(rendered).toContain("systempaths=unconfined");
    expect(rendered).toContain("/dev/net/tun:/dev/net/tun");
    // Bots' system-wide installs live in a volume, which an update's `up` creates.
    expect(rendered).toContain("- openteam_computer_local:/usr/local");
    expect(rendered).toMatch(/^ {2}openteam_computer_local:$/m);
  });
});
