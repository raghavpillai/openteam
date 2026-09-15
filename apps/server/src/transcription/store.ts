import { ApiError } from "@openteam/contracts";
import {
  defaultTranscriptionSettings,
  type TranscriptionSettings,
  type TranscriptionSettingsInput,
  type TranscriptionSettingsView,
} from "@openteam/contracts/transcription";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface StoredSettings extends TranscriptionSettings {
  version: 1;
  encryptedApiKey: string | null;
}

const invalid = (message: string) => new ApiError(400, "invalid_transcription_settings", message);

export function parseTranscriptionSettings(input: unknown): TranscriptionSettingsInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalid("Transcription settings are required.");
  const value = input as Record<string, unknown>;
  if (
    typeof value.enabled !== "boolean" ||
    !["openai", "openai-compatible"].includes(String(value.provider))
  ) {
    throw invalid("Choose a transcription provider and whether voice notes are enabled.");
  }
  const string = (field: string, limit: number) => {
    if (
      typeof value[field] !== "string" ||
      value[field].length > limit ||
      /[\x00-\x1f\x7f]/.test(value[field])
    ) {
      throw invalid(`Transcription ${field} is invalid.`);
    }
    return value[field].trim();
  };
  let baseUrl = string("baseUrl", 2048);
  const model = string("model", 256);
  const language = string("language", 20);
  if (language && !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language))
    throw invalid(
      "Use a language code such as en, or leave language blank for automatic detection."
    );
  if (value.provider === "openai") baseUrl = "https://api.openai.com/v1";
  if (baseUrl) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw invalid("Enter a full HTTP or HTTPS base URL, including the API path.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw invalid(
        "Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment."
      );
    }
    baseUrl = url.toString().replace(/\/+$/, "");
  }
  if (value.enabled && (!baseUrl || !model))
    throw invalid("A base URL and model are required to enable voice notes.");
  if (
    value.apiKey !== undefined &&
    value.apiKey !== null &&
    (typeof value.apiKey !== "string" ||
      !value.apiKey.trim() ||
      value.apiKey.length > 20_000 ||
      /[\x00-\x1f\x7f]/.test(value.apiKey))
  ) {
    throw invalid("The transcription API key is invalid.");
  }
  return {
    enabled: value.enabled,
    provider: value.provider as TranscriptionSettings["provider"],
    baseUrl,
    model,
    language,
    ...(value.apiKey !== undefined
      ? { apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : null }
      : {}),
  };
}

export class TranscriptionStore {
  private pendingWrite: Promise<unknown> = Promise.resolve();
  constructor(
    readonly path: string,
    private readonly secret: () => string | undefined = () =>
      process.env.OPENTEAM_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET
  ) {}

  private key(): Buffer {
    const secret = this.secret();
    if (!secret || secret.length < 32)
      throw invalid("Configure OPENTEAM_AUTH_SECRET before saving a transcription API key.");
    return createHash("sha256").update(`openteam-transcription-v1:${secret}`).digest();
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
  }

  private decrypt(value: string): string {
    try {
      const bytes = Buffer.from(value, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key(), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        "utf8"
      );
    } catch {
      throw invalid(
        "The saved transcription key cannot be decrypted. Save the key again in Server settings."
      );
    }
  }

  private async read(): Promise<StoredSettings> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      if (
        raw.version !== 1 ||
        (raw.encryptedApiKey !== null && typeof raw.encryptedApiKey !== "string")
      )
        throw invalid("Invalid saved transcription settings.");
      const { apiKey: _ignored, ...settings } = parseTranscriptionSettings(raw);
      return { ...settings, version: 1, encryptedApiKey: raw.encryptedApiKey };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...defaultTranscriptionSettings(), version: 1, encryptedApiKey: null };
      if (error instanceof ApiError) throw error;
      throw invalid("The saved transcription settings could not be read.");
    }
  }

  private viewOf(settings: StoredSettings): TranscriptionSettingsView {
    const { version: _version, encryptedApiKey, ...view } = settings;
    let keyValid = true;
    if (encryptedApiKey) {
      try {
        this.decrypt(encryptedApiKey);
      } catch {
        keyValid = false;
      }
    }
    return {
      ...view,
      hasApiKey: Boolean(encryptedApiKey),
      configured:
        keyValid &&
        view.enabled &&
        Boolean(view.baseUrl && view.model && (view.provider !== "openai" || encryptedApiKey)),
    };
  }

  async view(): Promise<TranscriptionSettingsView> {
    return this.viewOf(await this.read());
  }

  async status(): Promise<"configured" | "missing" | "invalid"> {
    try {
      const settings = await this.read();
      if (!settings.enabled) return "missing";
      if (settings.encryptedApiKey) this.decrypt(settings.encryptedApiKey);
      if (!this.viewOf(settings).configured) return "missing";
      return "configured";
    } catch {
      return "invalid";
    }
  }

  async credentials(): Promise<TranscriptionSettings & { apiKey: string | null }> {
    const settings = await this.read();
    if (!this.viewOf(settings).configured)
      throw new ApiError(
        503,
        "transcription_not_configured",
        "Set up transcription in Server settings to use voice notes."
      );
    const { encryptedApiKey, version: _version, ...rest } = settings;
    return { ...rest, apiKey: encryptedApiKey ? this.decrypt(encryptedApiKey) : null };
  }

  /** Resolve credentials for model discovery without persisting the draft or enabling audio. */
  async discoveryCredentials(input: unknown): Promise<{ baseUrl: string; apiKey: string | null }> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw invalid("Transcription settings are required.");
    const parsed = parseTranscriptionSettings({ ...input, enabled: false });
    if (!parsed.baseUrl) throw invalid("Enter a transcription base URL before browsing models.");
    const previous = await this.read();
    const sameEndpoint =
      previous.provider === parsed.provider && previous.baseUrl === parsed.baseUrl;
    const apiKey =
      parsed.apiKey === undefined
        ? sameEndpoint && previous.encryptedApiKey
          ? this.decrypt(previous.encryptedApiKey)
          : null
        : parsed.apiKey;
    if (parsed.provider === "openai" && !apiKey)
      throw invalid("Enter an OpenAI API key before browsing transcription models.");
    return { baseUrl: parsed.baseUrl, apiKey };
  }

  save(input: unknown): Promise<TranscriptionSettingsView> {
    const parsed = parseTranscriptionSettings(input);
    const operation = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        const previous = await this.read().catch(() => null);
        const sameEndpoint =
          previous?.provider === parsed.provider && previous?.baseUrl === parsed.baseUrl;
        // Never carry a credential to a newly selected endpoint implicitly.
        const encryptedApiKey =
          parsed.apiKey === undefined
            ? sameEndpoint
              ? (previous?.encryptedApiKey ?? null)
              : null
            : parsed.apiKey === null
              ? null
              : this.encrypt(parsed.apiKey);
        if (parsed.enabled && parsed.provider === "openai" && !encryptedApiKey)
          throw invalid("An OpenAI API key is required to enable transcription.");
        const { apiKey: _key, ...settings } = parsed;
        const document: StoredSettings = { ...settings, version: 1, encryptedApiKey };
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", {
            mode: 0o600,
            flag: "wx",
          });
          await rename(temporary, this.path);
        } finally {
          await rm(temporary, { force: true });
        }
        return this.viewOf(document);
      });
    this.pendingWrite = operation;
    return operation;
  }
}
