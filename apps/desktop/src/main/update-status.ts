import { isOpenBotVersion } from "@openbot/contracts/version-compatibility";
import { safeErrorMessage } from "@openbot/product-core/redaction";

export type DesktopUpdateFailureKind =
  | "service-unavailable"
  | "feed-http-status"
  | "feed-malformed"
  | "signature-invalid"
  | "download-failed"
  | "apply-unsupported"
  | "unknown";

export interface DesktopUpdateSnapshot {
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string;
  status:
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    | "error";
  progress: number | null;
  message: string | null;
  failureKind: DesktopUpdateFailureKind | null;
  track: "stable";
}

export const classifyDesktopUpdateError = (
  error: unknown,
  phase: DesktopUpdateSnapshot["status"]
): { failureKind: DesktopUpdateFailureKind; message: string } => {
  const message = safeErrorMessage(error);
  const normalized = message.toLowerCase();
  if (/signature|code.?sign|sha(?:256|512)|checksum|notariz/.test(normalized)) {
    return { failureKind: "signature-invalid", message };
  }
  if (/unsupported|not supported|cannot be installed|cannot apply/.test(normalized)) {
    return { failureKind: "apply-unsupported", message };
  }
  if (phase === "downloading" || /download/.test(normalized)) {
    return { failureKind: "download-failed", message };
  }
  if (/http|status\s+\d{3}|returned\s+\d{3}/.test(normalized)) {
    return { failureKind: "feed-http-status", message };
  }
  if (/json|parse|manifest|feed|version/.test(normalized)) {
    return { failureKind: "feed-malformed", message };
  }
  if (/network|offline|unreachable|timed?\s*out|econn|enotfound/.test(normalized)) {
    return { failureKind: "service-unavailable", message };
  }
  return { failureKind: "unknown", message };
};

export const parseDesktopReleaseManifest = (
  value: unknown,
  fallbackUrl: string
): { version: string; downloadUrl: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Update service returned a malformed release manifest");
  }
  const record = value as Record<string, unknown>;
  const version = String(record.tag_name ?? record.version ?? "").replace(/^v/i, "");
  if (!isOpenBotVersion(version)) {
    throw new Error("Update service returned an invalid release version");
  }
  const candidateUrl = String(record.html_url ?? record.url ?? fallbackUrl);
  return {
    version,
    downloadUrl: candidateUrl.startsWith("https://") ? candidateUrl : fallbackUrl,
  };
};
