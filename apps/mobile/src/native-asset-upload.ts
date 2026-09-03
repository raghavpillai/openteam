import type { AssetRef } from "@openteam/contracts";
import type { UploadOptions, UploadProgress, UploadResult } from "expo-file-system";

export interface NativeUploadTask {
  uploadAsync(): Promise<UploadResult>;
}

export interface NativeUploadFile {
  createUploadTask(url: string, options?: UploadOptions): NativeUploadTask;
}

export interface NativeAssetUploadInput {
  serverUrl: string;
  file: NativeUploadFile;
  fileName: string;
  mimeType?: string;
  alt?: string;
  authToken?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  onUnauthorized?: () => void;
}

const assetRefFrom = (value: unknown): AssetRef => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenTeam returned an invalid attachment response");
  }
  const candidate = value as Partial<AssetRef>;
  if (
    typeof candidate.assetId !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.assetId) ||
    typeof candidate.fileName !== "string" ||
    typeof candidate.mimeType !== "string" ||
    typeof candidate.byteSize !== "number" ||
    typeof candidate.kind !== "string"
  ) {
    throw new Error("OpenTeam returned an invalid attachment response");
  }
  return candidate as AssetRef;
};

/** Uses the native file-backed URLSession uploader; the JS runtime never materializes file bytes. */
export const uploadNativeAsset = async (input: NativeAssetUploadInput): Promise<AssetRef> => {
  const mimeType = input.mimeType?.trim() || "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": mimeType,
    "x-file-name": encodeURIComponent(input.fileName),
  };
  if (input.authToken?.trim()) headers.authorization = `Bearer ${input.authToken.trim()}`;
  const task = input.file.createUploadTask(`${input.serverUrl}/api/v0/assets`, {
    httpMethod: "POST",
    headers,
    mimeType,
    onProgress: input.onProgress,
    sessionType: "foreground",
    signal: input.signal,
  });
  const result = await task.uploadAsync();
  let body: unknown = null;
  try {
    body = result.body ? JSON.parse(result.body) : null;
  } catch {
    // The status-specific fallback below is more useful than a JSON parser error.
  }
  if (result.status === 401) input.onUnauthorized?.();
  if (result.status < 200 || result.status >= 300) {
    const message =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { error?: { message?: unknown } }).error?.message
        : null;
    throw new Error(
      typeof message === "string" ? message : `Attachment upload failed (${result.status})`
    );
  }
  const asset = assetRefFrom(body);
  return input.alt ? { ...asset, alt: input.alt } : asset;
};
