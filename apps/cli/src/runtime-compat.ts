import crypto from "node:crypto";

/**
 * Node's `crypto.verify` picks a default digest when the algorithm is `undefined`
 * (SHA-256 for EC and RSA keys, none for Ed25519/Ed448). Bun's BoringSSL-backed
 * implementation throws `NO_DEFAULT_DIGEST` instead, and the Sigstore and TUF
 * libraries the release verifier relies on omit the algorithm in several places.
 * Under Bun that surfaces as "root was signed by 0/3 keys" or "inclusion promise
 * could not be verified" for a perfectly valid release. Mirror Node's default so the
 * compiled CLI verifies the same bundles Node does.
 */
type VerifyKey = Parameters<typeof crypto.verify>[2];

const keyObjectFrom = (key: VerifyKey): crypto.KeyObject | null => {
  try {
    const candidate =
      key && typeof key === "object" && "key" in key ? (key as { key: unknown }).key : key;
    return candidate instanceof crypto.KeyObject
      ? candidate
      : crypto.createPublicKey(candidate as crypto.PublicKeyInput | string | Buffer);
  } catch {
    return null;
  }
};

const nodeDefaultDigest = (key: VerifyKey): string | undefined => {
  const type = keyObjectFrom(key)?.asymmetricKeyType;
  return type === "ed25519" || type === "ed448" ? undefined : "sha256";
};

type VerifyArgs = [
  algorithm: string | null | undefined,
  data: NodeJS.ArrayBufferView,
  key: VerifyKey,
  signature: NodeJS.ArrayBufferView,
  callback?: (error: Error | null, result: boolean) => void,
];
type PatchedVerify = typeof crypto.verify & { openteamPatched?: boolean };

export const installCryptoVerifyDefaults = (): boolean => {
  if (typeof Bun === "undefined") return false;
  const current = crypto.verify as PatchedVerify;
  if (current.openteamPatched) return true;
  const original = current as unknown as (...args: VerifyArgs) => unknown;
  const patched = ((...args: VerifyArgs) => {
    const [algorithm, data, key, signature, callback] = args;
    const resolved = algorithm ?? nodeDefaultDigest(key);
    return callback
      ? original(resolved, data, key, signature, callback)
      : original(resolved, data, key, signature);
  }) as unknown as PatchedVerify;
  patched.openteamPatched = true;
  (crypto as { verify: typeof crypto.verify }).verify = patched;
  return true;
};

installCryptoVerifyDefaults();
