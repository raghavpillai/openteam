export interface DownloadAssetRequest {
  fileName: string;
  url: string;
}

const safeDownloadName = (value: string) => {
  const leaf = value.normalize("NFKC").split(/[\\/]/).at(-1)?.trim() || "attachment";
  const safe = Array.from(leaf, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f || /[\\/:*?"<>|]/.test(character)
      ? "_"
      : character;
  })
    .join("")
    .slice(0, 180);
  return safe || "attachment";
};

/** Only the server selected through the main-frame connection IPC may receive credentials. */
export const downloadAssetRequests = (
  value: unknown,
  serverUrl: string | null
): DownloadAssetRequest[] | null => {
  if (!serverUrl || !Array.isArray(value) || value.length === 0 || value.length > 24) return null;
  let server: URL;
  try {
    server = new URL(serverUrl);
    if (
      !["http:", "https:"].includes(server.protocol) ||
      server.username || server.password || server.search || server.hash
    ) return null;
  } catch {
    return null;
  }
  const assetPath = `${server.pathname.replace(/\/+$/, "")}/api/v0/assets/`;
  const parsed = value.map((candidate): DownloadAssetRequest | null => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const request = candidate as Partial<DownloadAssetRequest>;
    if (typeof request.fileName !== "string" || typeof request.url !== "string") return null;
    try {
      const url = new URL(request.url);
      if (
        url.origin !== server.origin ||
        url.username || url.password ||
        !url.pathname.startsWith(assetPath) ||
        !/^[a-f0-9]{64}$/.test(url.pathname.slice(assetPath.length))
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return { fileName: safeDownloadName(request.fileName), url: request.url };
  });
  return parsed.every((candidate): candidate is DownloadAssetRequest => candidate !== null)
    ? parsed
    : null;
};
