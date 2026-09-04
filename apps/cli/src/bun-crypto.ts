import crypto from "node:crypto";

export const needsCryptoVerifyCompatibility = (
  versions: Readonly<Record<string, string | undefined>> = process.versions
): boolean => Boolean(versions.bun || versions.electron);

const digestForKey = (key: Parameters<typeof crypto.verify>[2]): string | null => {
  try {
    const rawKey = typeof key === "object" && key !== null && "key" in key ? key.key : key;
    if (!(rawKey instanceof crypto.KeyObject)) return null;
    const keyObject = rawKey;
    return ["ec", "rsa", "rsa-pss", "dsa"].includes(keyObject.asymmetricKeyType ?? "")
      ? "sha256"
      : null;
  } catch {
    return null;
  }
};

export const withBunCryptoVerifyCompatibility = async <Result>(
  action: () => Promise<Result>
): Promise<Result> => {
  if (!needsCryptoVerifyCompatibility()) return action();

  const originalVerify = crypto.verify;
  const compatibleVerify = ((...args: Parameters<typeof crypto.verify>) => {
    const [algorithm, data, key, signature] = args;
    return originalVerify(algorithm ?? digestForKey(key), data, key, signature);
  }) as typeof crypto.verify;
  crypto.verify = compatibleVerify;
  try {
    return await action();
  } finally {
    crypto.verify = originalVerify;
  }
};
