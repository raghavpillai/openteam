import { readFileSync } from "node:fs";
import { parseEnvironment, type InstallationPaths } from "./config";
import type { DoctorCheck } from "./doctor";
import { healthUrl } from "./health";

export async function checkTranscription(paths: InstallationPaths): Promise<DoctorCheck> {
  try {
    const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
    const token = environment.get("OPENTEAM_CONTROL_TOKEN");
    if (!token) throw new Error("Missing installation control token.");
    const response = await fetch(
      new URL("/api/v0/internal/server-settings/transcription/check", healthUrl(paths)),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) throw new Error("Transcription diagnostic request failed.");
    const check = (await response.json()) as { level: DoctorCheck["level"]; detail: string };
    if (!["pass", "warn", "fail"].includes(check.level) || typeof check.detail !== "string")
      throw new Error("Invalid transcription diagnostic response.");
    return { label: "Transcription", level: check.level, detail: check.detail.slice(0, 500) };
  } catch {
    return {
      label: "Transcription",
      level: "fail",
      detail:
        "Could not check transcription through the OpenTeam server. Check the server connection and installation credentials.",
    };
  }
}
