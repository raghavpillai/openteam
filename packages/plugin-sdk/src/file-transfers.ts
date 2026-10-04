export function fileTransferCapabilities(provider: string) {
  return ["google-drive", "gmail"].includes(provider) ? { upload: true, download: true } : undefined;
}
