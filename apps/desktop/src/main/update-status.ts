import { existsSync } from "node:fs";
import { join } from "node:path";
import { isOpenTeamVersion } from "@openteam/contracts/version-compatibility";
import { safeErrorMessage } from "@openteam/product-core/redaction";

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

// electron-builder writes app-update.yml only for installer targets (DMG, ZIP, AppImage).
// Directory builds such as package:mac-local have no feed and can't update themselves.
export const hasDesktopUpdateFeed = (resourcesPath: string): boolean =>
  existsSync(join(resourcesPath, "app-update.yml"));

export const classifyDesktopUpdateError = (
  error: unknown,
  phase: DesktopUpdateSnapshot["status"]
): { failureKind: DesktopUpdateFailureKind; message: string } => {
  // electron-updater appends stacks, response headers and the entire Atom feed.
  // Release notes in that payload can mention signatures without a verification failure.
  const diagnostic =
    safeErrorMessage(error).split(/\r?\n|\\n|\b(?:XML|Data|Headers|rawData):/i, 1)[0] ?? "";
  const normalized = diagnostic.toLowerCase();
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const statusCode =
    error && typeof error === "object" && "statusCode" in error ? String(error.statusCode) : "";
  const status = /^[45]\d{2}$/.test(statusCode)
    ? statusCode
    : normalized.match(
        /\b(?:httperror\s*:|http\s*(?:status\s*)?:?|status\s*(?:code\s*)?:?|returned)\s*([45]\d{2})\b/
      )?.[1];
  if (status || /\bhttp(?:error)?\b/.test(normalized)) {
    return {
      failureKind: phase === "downloading" ? "download-failed" : "feed-http-status",
      message: `The update service returned ${status ? `HTTP ${status}` : "an HTTP error"}. Try again in a few minutes.`,
    };
  }
  if (
    /network|offline|unreachable|timed?\s*out|time-?out|econn|enotfound/.test(
      normalized + " " + code.toLowerCase()
    )
  ) {
    return {
      failureKind: phase === "downloading" ? "download-failed" : "service-unavailable",
      message: "The update service is currently unreachable. Check your connection and try again.",
    };
  }
  if (
    /feed|manifest|update info/.test(normalized) ||
    /ERR_UPDATER_(?:INVALID_RELEASE_FEED|INVALID_UPDATE_INFO|NO_CHECKSUM)/.test(code)
  ) {
    return {
      failureKind: "feed-malformed",
      message: "The update service returned invalid release information. Try again later.",
    };
  }
  if (
    /signature|code.?sign|sha(?:256|512)|checksum|notariz/.test(normalized) ||
    /SIGNATURE|CHECKSUM/.test(code)
  ) {
    return {
      failureKind: "signature-invalid",
      message: "The downloaded update failed signature verification and was not installed.",
    };
  }
  if (/unsupported|not supported|cannot be installed|cannot apply/.test(normalized)) {
    return {
      failureKind: "apply-unsupported",
      message: "The downloaded update cannot be installed on this platform.",
    };
  }
  if (phase === "downloading" || /download/.test(normalized)) {
    return {
      failureKind: "download-failed",
      message: "The update could not be downloaded. Try again.",
    };
  }
  if (/json|parse|manifest|feed|version/.test(normalized)) {
    return {
      failureKind: "feed-malformed",
      message: "The update service returned invalid release information. Try again later.",
    };
  }
  return { failureKind: "unknown", message: "The desktop update failed. Try again." };
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
  if (!isOpenTeamVersion(version)) {
    throw new Error("Update service returned an invalid release version");
  }
  const candidateUrl = String(record.html_url ?? record.url ?? fallbackUrl);
  return {
    version,
    downloadUrl: candidateUrl.startsWith("https://") ? candidateUrl : fallbackUrl,
  };
};
