import { chmod, stat } from "node:fs/promises";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { bundleToJSON } from "@sigstore/bundle";
import { MessageSignatureBundleBuilder, RekorWitness } from "@sigstore/sign";
import { LOCAL_RELEASE_KEY_ID, LOCAL_RELEASE_PUBLIC_KEY, localReleaseSigningPayload } from "../src/release-signing-key";
import { verifyArtifactSignature } from "../src/release";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass at least one release artifact to sign");
const keyPath = process.env.OPENTEAM_RELEASE_SIGNING_KEY_PATH;
if (!keyPath || ((await stat(keyPath)).mode & 0o077))
  throw new Error("Set OPENTEAM_RELEASE_SIGNING_KEY_PATH to a protected local key file");
const key = createPrivateKey(await Bun.file(keyPath).text());
const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
if (publicKey !== LOCAL_RELEASE_PUBLIC_KEY) throw new Error("Signing key does not match the pinned release identity");
const version = (await Bun.file(new URL("../package.json", import.meta.url)).json()).version;
const repository = "raghavpillai/openteam";
const builder = new MessageSignatureBundleBuilder({
  signer: { sign: async data => ({ signature: sign("sha256", data, key), key: { $case: "publicKey", publicKey, hint: LOCAL_RELEASE_KEY_ID } }) },
  witnesses: [new RekorWitness({ timeout: 30_000, retry: 2, fetchOnConflict: true })],
});
for (const file of files) {
  const artifact = Buffer.from(await Bun.file(file).arrayBuffer());
  const bundle = await builder.create({ data: localReleaseSigningPayload(repository, version, artifact) });
  const serializedBundle = JSON.stringify(bundleToJSON(bundle));
  await verifyArtifactSignature({ repository, version, artifact, serializedBundle });
  const destination = `${file}.sigstore.json`;
  await Bun.write(destination, serializedBundle + "\n");
  await chmod(destination, 0o600);
  console.log(`Signed and verified ${file} → ${destination}`);
}
