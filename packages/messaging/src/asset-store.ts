import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, type AssetKind, type AssetRef } from "@openbot/contracts";

export const REGULAR_ASSET_LIMIT = 25 * 1024 * 1024;
export const VIDEO_ASSET_LIMIT = 200 * 1024 * 1024;
export const MAX_MESSAGE_ASSETS = 6;
const REMOTE_READ_CHUNK = 1024 * 1024;
const ASSET_ID = /^[a-f0-9]{64}$/;
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"]);
const DATA_IMAGE = /^data:image\/(gif|jpeg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/i;
const ASSET_KINDS = new Set<AssetKind>(["image", "video", "audio", "pdf", "text", "file"]);

const privateNetworkAddress = (address: string): boolean => {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : null);
  if (!ipv4) return false;
  const [a = 0, b = 0] = ipv4.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

const assertPublicHttps = async (url: URL): Promise<void> => {
  if (url.protocol !== "https:") {
    throw new ApiError(400, "invalid_asset_url", "Attachment URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "invalid_asset_url", "Attachment URL cannot contain credentials");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ApiError(400, "private_asset_url", "Attachment URL cannot target a private host");
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some(({ address }) => privateNetworkAddress(address))) {
    throw new ApiError(400, "private_asset_url", "Attachment URL cannot target a private network");
  }
};

interface AssetMetadata {
  assetId: string;
  byteSize: number;
  mimeType: string;
  kind: AssetKind;
  width?: number;
  height?: number;
  createdAt: string;
}

export interface AssetStoreOptions {
  root?: string;
  allowedFileRoots?: readonly string[];
  fetch?: typeof fetch;
}

const within = (root: string, candidate: string): boolean => {
  const suffix = relative(root, candidate);
  return (
    suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
  );
};

const safeFileName = (value: string): string => {
  const normalized = value.normalize("NFKC").trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
  if (
    !normalized ||
    normalized.length > 255 ||
    normalized !== basename(normalized) ||
    normalized.includes("\\") ||
    normalized.includes("/") ||
    hasControlCharacter
  ) {
    throw new ApiError(400, "invalid_asset_filename", "Attachment filename is not safe");
  }
  return normalized;
};

const videoLike = (fileName: string, declaredMime?: string): boolean => {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return (
    VIDEO_EXTENSIONS.has(extension) || declaredMime?.toLowerCase().startsWith("video/") === true
  );
};

const jpegDimensions = (bytes: Uint8Array): { width: number; height: number } | null => {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3 && length >= 7) {
      return {
        height: ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0),
        width: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
      };
    }
    offset += length;
  }
  return null;
};

const imageDimensions = (bytes: Uint8Array, mimeType: string) => {
  if (mimeType === "image/png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === "image/gif" && bytes.length >= 10) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  if (mimeType === "image/webp" && bytes.length >= 30) {
    const tag = Buffer.from(bytes.subarray(12, 16)).toString("ascii");
    if (tag === "VP8X") {
      return {
        width: 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16),
        height: 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16),
      };
    }
  }
  return null;
};

const starts = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, index) => bytes[index] === value);

const classify = (
  bytes: Uint8Array,
  fileName: string,
  declaredMime?: string
): Pick<AssetMetadata, "kind" | "mimeType" | "width" | "height"> => {
  let mimeType = "application/octet-stream";
  let kind: AssetKind = "file";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    mimeType = "image/png";
    kind = "image";
  } else if (starts(bytes, [0xff, 0xd8, 0xff])) {
    mimeType = "image/jpeg";
    kind = "image";
  } else if (
    Buffer.from(bytes.subarray(0, 6))
      .toString("ascii")
      .match(/^GIF8[79]a$/)
  ) {
    mimeType = "image/gif";
    kind = "image";
  } else if (
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    mimeType = "image/webp";
    kind = "image";
  } else if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") {
    mimeType = "application/pdf";
    kind = "pdf";
  } else if (bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp") {
    mimeType = "video/mp4";
    kind = "video";
  } else if (videoLike(fileName, declaredMime)) {
    mimeType = declaredMime?.toLowerCase().startsWith("video/")
      ? declaredMime.toLowerCase()
      : "video/mp4";
    kind = "video";
  } else if (declaredMime?.toLowerCase().startsWith("audio/")) {
    mimeType = declaredMime.toLowerCase();
    kind = "audio";
  } else {
    const declared = declaredMime?.trim().toLowerCase();
    const textLike =
      declared?.startsWith("text/") ||
      declared === "application/json" ||
      /\.(?:csv|json|log|md|markdown|txt)$/i.test(fileName);
    if (textLike && !bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)) {
      mimeType =
        declared === "application/json"
          ? "application/json"
          : declared === "text/csv"
            ? "text/csv"
            : declared === "text/markdown"
              ? "text/markdown"
              : "text/plain";
      kind = "text";
    }
  }
  const dimensions = kind === "image" ? imageDimensions(bytes, mimeType) : null;
  return { kind, mimeType, ...(dimensions ?? {}) };
};

const strictBase64 = (value: string): Uint8Array => {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ApiError(400, "invalid_asset_bytes", "Attachment bytes are not valid base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) {
    throw new ApiError(400, "empty_asset", "Attachment is empty");
  }
  return bytes;
};

export class AssetStore {
  readonly root: string;
  private readonly allowedFileRoots: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly verifiedAssets = new Map<
    string,
    {
      blobMtimeMs: number;
      metadataMtimeMs: number;
      metadata: AssetMetadata;
    }
  >();

  constructor(options: AssetStoreOptions = {}) {
    this.root = resolve(
      options.root ??
        process.env.OPENBOT_ASSET_ROOT ??
        join(process.env.OPENBOT_WORKSPACE_ROOT ?? "/workspace", ".openbot", "assets")
    );
    this.allowedFileRoots = (
      options.allowedFileRoots ?? [process.env.OPENBOT_WORKSPACE_ROOT ?? "/workspace"]
    ).map((root) => resolve(root));
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  decodeUpload(input: { fileName: string; mimeType?: string; bytesBase64: string; alt?: string }) {
    return this.ingestBytes({
      fileName: input.fileName,
      mimeType: input.mimeType,
      bytes: strictBase64(input.bytesBase64),
      alt: input.alt,
    });
  }

  async ingestBytes(input: {
    fileName: string;
    mimeType?: string;
    bytes: Uint8Array;
    alt?: string;
  }): Promise<AssetRef> {
    const fileName = safeFileName(input.fileName);
    const maximum = videoLike(fileName, input.mimeType) ? VIDEO_ASSET_LIMIT : REGULAR_ASSET_LIMIT;
    if (input.bytes.length === 0) throw new ApiError(400, "empty_asset", "Attachment is empty");
    if (input.bytes.length > maximum) {
      throw new ApiError(
        413,
        "asset_too_large",
        `Attachment exceeds the ${Math.round(maximum / 1024 / 1024)} MB limit`
      );
    }
    const assetId = createHash("sha256").update(input.bytes).digest("hex");
    const detected = classify(input.bytes, fileName, input.mimeType);
    const metadata: AssetMetadata = {
      assetId,
      byteSize: input.bytes.length,
      ...detected,
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const blobPath = this.blobPath(assetId);
    const metadataPath = this.metadataPath(assetId);
    if (!(await stat(blobPath).catch(() => null))) {
      await this.atomicWrite(blobPath, input.bytes);
    }
    if (!(await stat(metadataPath).catch(() => null))) {
      await this.atomicWrite(metadataPath, Buffer.from(JSON.stringify(metadata)));
    }
    const verified = await this.metadata(assetId);
    return {
      assetId,
      fileName,
      mimeType: verified.mimeType,
      byteSize: verified.byteSize,
      kind: verified.kind,
      ...(verified.width ? { width: verified.width } : {}),
      ...(verified.height ? { height: verified.height } : {}),
      ...(input.alt?.trim() ? { alt: input.alt.trim().slice(0, 2_000) } : {}),
    };
  }

  async ingestSource(input: {
    url: string;
    fileName?: string;
    mimeType?: string;
    alt?: string;
  }): Promise<AssetRef> {
    const dataImage = input.url.match(DATA_IMAGE);
    if (dataImage) {
      const subtype = dataImage[1]?.toLowerCase();
      const payload = dataImage[2];
      if (!subtype || payload === undefined) {
        throw new ApiError(400, "invalid_asset_data", "Attachment image data is malformed");
      }
      return this.ingestBytes({
        fileName: input.fileName ?? `image.${subtype === "jpeg" ? "jpg" : subtype}`,
        mimeType: `image/${subtype}`,
        bytes: strictBase64(payload),
        alt: input.alt,
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new ApiError(
        400,
        "invalid_asset_url",
        "Attachment URL must use a supported image data URL, file:, or https:"
      );
    }
    if (parsed.protocol === "file:") {
      const requested = fileURLToPath(parsed);
      if (!isAbsolute(requested)) {
        throw new ApiError(400, "invalid_asset_path", "Attachment path must be absolute");
      }
      const source = await realpath(requested).catch(() => null);
      const roots = await Promise.all(
        this.allowedFileRoots.map((root) => realpath(root).catch(() => resolve(root)))
      );
      if (!source || !roots.some((root) => within(root, source))) {
        throw new ApiError(
          400,
          "asset_path_outside_store",
          "Attachment path is outside an allowed OpenBot directory"
        );
      }
      const info = await stat(source);
      if (!info.isFile()) throw new ApiError(400, "invalid_asset_path", "Attachment is not a file");
      const fileName = input.fileName ?? basename(source);
      const maximum = videoLike(fileName, input.mimeType) ? VIDEO_ASSET_LIMIT : REGULAR_ASSET_LIMIT;
      if (info.size > maximum)
        throw new ApiError(413, "asset_too_large", "Attachment exceeds its size limit");
      return this.ingestBytes({
        fileName,
        mimeType: input.mimeType,
        bytes: await readFile(source),
        alt: input.alt,
      });
    }
    if (parsed.protocol !== "https:") {
      throw new ApiError(
        400,
        "invalid_asset_url",
        "Attachment URL must use a supported image data URL, file:, or https:"
      );
    }
    let remoteUrl = parsed;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertPublicHttps(remoteUrl);
      response = await this.fetchImpl(remoteUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirects === 3) {
        throw new ApiError(
          400,
          "asset_fetch_failed",
          location ? "Attachment URL redirected too many times" : "Attachment redirect is invalid"
        );
      }
      remoteUrl = new URL(location, remoteUrl);
    }
    if (!response) {
      throw new ApiError(400, "asset_fetch_failed", "Attachment download failed");
    }
    if (!response.ok || !response.body) {
      throw new ApiError(
        400,
        "asset_fetch_failed",
        `Attachment download failed (${response.status})`
      );
    }
    const fileName = input.fileName ?? (basename(remoteUrl.pathname) || "attachment");
    const mimeType =
      input.mimeType ?? response.headers.get("content-type")?.split(";", 1)[0] ?? undefined;
    const maximum = videoLike(fileName, mimeType) ? VIDEO_ASSET_LIMIT : REGULAR_ASSET_LIMIT;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximum) {
      throw new ApiError(413, "asset_too_large", "Attachment exceeds its size limit");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new ApiError(413, "asset_too_large", "Attachment exceeds its size limit");
      }
      for (let offset = 0; offset < value.length; offset += REMOTE_READ_CHUNK) {
        chunks.push(value.subarray(offset, offset + REMOTE_READ_CHUNK));
      }
    }
    return this.ingestBytes({
      fileName,
      mimeType,
      bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
      alt: input.alt,
    });
  }

  async normalizeRefs(refs: readonly AssetRef[]): Promise<AssetRef[]> {
    if (refs.length > MAX_MESSAGE_ASSETS) {
      throw new ApiError(
        400,
        "too_many_assets",
        `A message can contain at most ${MAX_MESSAGE_ASSETS} attachments`
      );
    }
    return Promise.all(
      refs.map(async (ref) => {
        const metadata = await this.metadata(ref.assetId);
        return {
          assetId: metadata.assetId,
          fileName: safeFileName(ref.fileName),
          mimeType: metadata.mimeType,
          byteSize: metadata.byteSize,
          kind: metadata.kind,
          ...(metadata.width ? { width: metadata.width } : {}),
          ...(metadata.height ? { height: metadata.height } : {}),
          ...(ref.alt?.trim() ? { alt: ref.alt.trim().slice(0, 2_000) } : {}),
        };
      })
    );
  }

  async metadata(assetId: string): Promise<AssetMetadata> {
    this.assertAssetId(assetId);
    const metadataPath = this.metadataPath(assetId);
    const blobPath = this.blobPath(assetId);
    const [metadataInfo, blobInfo] = await Promise.all([
      stat(metadataPath).catch(() => null),
      stat(blobPath).catch(() => null),
    ]);
    if (!metadataInfo?.isFile() || !blobInfo?.isFile()) {
      this.verifiedAssets.delete(assetId);
      throw new ApiError(404, "asset_not_found", "Attachment is missing");
    }
    const cached = this.verifiedAssets.get(assetId);
    if (
      cached &&
      cached.blobMtimeMs === blobInfo.mtimeMs &&
      cached.metadataMtimeMs === metadataInfo.mtimeMs
    ) {
      return cached.metadata;
    }
    let parsed: AssetMetadata;
    try {
      parsed = JSON.parse(await readFile(metadataPath, "utf8")) as AssetMetadata;
    } catch {
      throw new ApiError(409, "asset_corrupt", "Attachment metadata is corrupt");
    }
    if (
      parsed.assetId !== assetId ||
      parsed.byteSize !== blobInfo.size ||
      !Number.isSafeInteger(parsed.byteSize) ||
      parsed.byteSize <= 0 ||
      typeof parsed.mimeType !== "string" ||
      parsed.mimeType.length === 0 ||
      !ASSET_KINDS.has(parsed.kind) ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      (parsed.width !== undefined && (!Number.isSafeInteger(parsed.width) || parsed.width <= 0)) ||
      (parsed.height !== undefined && (!Number.isSafeInteger(parsed.height) || parsed.height <= 0))
    ) {
      throw new ApiError(409, "asset_corrupt", "Attachment metadata is corrupt");
    }
    const digest = createHash("sha256");
    try {
      for await (const chunk of createReadStream(blobPath)) digest.update(chunk);
    } catch {
      throw new ApiError(409, "asset_corrupt", "Attachment content cannot be verified");
    }
    if (digest.digest("hex") !== assetId) {
      throw new ApiError(409, "asset_corrupt", "Attachment content does not match its id");
    }
    this.verifiedAssets.set(assetId, {
      blobMtimeMs: blobInfo.mtimeMs,
      metadataMtimeMs: metadataInfo.mtimeMs,
      metadata: parsed,
    });
    return parsed;
  }

  async runtimeImages(refs: readonly AssetRef[]): Promise<Array<{ url: string; alt?: string }>> {
    const normalized = await this.normalizeRefs(refs.filter((ref) => ref.kind === "image"));
    return Promise.all(
      normalized.map(async (ref) => ({
        url: `data:${ref.mimeType};base64,${(await readFile(this.blobPath(ref.assetId))).toString("base64")}`,
        ...(ref.alt ? { alt: ref.alt } : {}),
      }))
    );
  }

  contentPath(assetId: string): string {
    this.assertAssetId(assetId);
    return this.blobPath(assetId);
  }

  async prune(
    referencedAssetIds: ReadonlySet<string>,
    graceMs = 24 * 60 * 60_000
  ): Promise<number> {
    const entries = await readdir(this.root).catch(() => []);
    const cutoff = Date.now() - graceMs;
    let removed = 0;
    for (const entry of entries) {
      const match = entry.match(/^([a-f0-9]{64})\.(?:blob|json)$/);
      const assetId = match?.[1];
      if (!assetId || referencedAssetIds.has(assetId)) continue;
      const info = await stat(join(this.root, entry)).catch(() => null);
      if (!info || info.mtimeMs > cutoff) continue;
      await Promise.all([
        rm(this.blobPath(assetId), { force: true }),
        rm(this.metadataPath(assetId), { force: true }),
      ]);
      this.verifiedAssets.delete(assetId);
      removed += 1;
    }
    return removed;
  }

  private assertAssetId(assetId: string) {
    if (!ASSET_ID.test(assetId)) {
      throw new ApiError(400, "invalid_asset_id", "Attachment id is invalid");
    }
  }

  private blobPath(assetId: string) {
    this.assertAssetId(assetId);
    return join(this.root, `${assetId}.blob`);
  }

  private metadataPath(assetId: string) {
    this.assertAssetId(assetId);
    return join(this.root, `${assetId}.json`);
  }

  private async atomicWrite(path: string, bytes: Uint8Array) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path).catch(async (error) => {
      await rm(temporary, { force: true });
      if (!(await stat(path).catch(() => null))) throw error;
    });
  }
}
