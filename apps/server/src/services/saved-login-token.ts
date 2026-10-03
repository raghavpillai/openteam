import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Database envelopes; the key is derived from the deployment secret, never stored in the DB. */
export class SavedLoginTokenCipher {
  constructor(private readonly secret: () => string | undefined = () =>
    process.env.OPENTEAM_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET) {}
  private key() {
    const secret = this.secret();
    if (!secret || secret.length < 32) throw new Error("Configure OPENTEAM_AUTH_SECRET before connecting 1Password");
    return createHash("sha256").update(`openteam-saved-logins-v1:${secret}`).digest();
  }
  encrypt(token: string, connectionId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(connectionId));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
  }
  decrypt(envelope: string, connectionId: string): string {
    try {
      if (!envelope.startsWith("enc:v1:")) throw new Error();
      const bytes = Buffer.from(envelope.slice(7), "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key(), bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(connectionId));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    } catch { throw new Error("Reconnect 1Password: the saved token could not be decrypted"); }
  }
}
