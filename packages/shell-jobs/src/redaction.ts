import { StringDecoder } from "node:string_decoder";

/** Literal redaction across arbitrary UTF-8 stream chunks. A pending prefix is
 * retained until it can no longer complete a secret. Never write raw chunks. */
export class SecretRedactor {
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly secrets: string[];
  constructor(values: readonly string[]) {
    this.secrets = [
      ...new Set(
        values.filter(Boolean).flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
      ),
    ].sort((a, b) => b.length - a.length);
  }
  write(chunk: Buffer): Buffer {
    return this.consume(this.decoder.write(chunk), false);
  }
  end(): Buffer {
    return this.consume(this.decoder.end(), true);
  }
  private consume(text: string, final: boolean): Buffer {
    const value = this.pending + text;
    this.pending = "";
    if (!this.secrets.length) return Buffer.from(value);
    let result = "";
    for (let i = 0; i < value.length; ) {
      const remainingLength = value.length - i;
      if (
        !final &&
        this.secrets.some(
          (secret) => secret.length > remainingLength && secret.startsWith(value.slice(i))
        )
      ) {
        this.pending = value.slice(i);
        break;
      }
      const match = this.secrets.find((secret) => value.startsWith(secret, i));
      if (match) {
        result += "[REDACTED]";
        i += match.length;
        continue;
      }
      result += value[i++];
    }
    return Buffer.from(result);
  }
}

export function redactSecrets(text: string, values: readonly string[]): string {
  const redactor = new SecretRedactor(values);
  return Buffer.concat([redactor.write(Buffer.from(text)), redactor.end()]).toString();
}
