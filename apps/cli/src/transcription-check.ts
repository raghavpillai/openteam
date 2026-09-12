import { readFileSync } from "node:fs";
import { parseEnvironment, type InstallationPaths } from "./config";
import type { DoctorCheck } from "./doctor";
import { healthUrl } from "./health";

export async function checkTranscription(paths: InstallationPaths): Promise<DoctorCheck> {
  try {
    const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
    const token = environment.get("OPENTEAM_CONTROL_TOKEN");
    if (!token) throw new Error("Missing installation control token.");
    const signal = AbortSignal.timeout(10_000);
    const response = await fetch(
      new URL("/api/v0/internal/server-settings/transcription/check", healthUrl(paths)),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal,
      }
    );
    // Older servers send unknown internal paths through owner authentication,
    // which can yield 401 instead of 404. Verify the control token on their
    // existing settings route before identifying that as an older server.
    const legacyRoute =
      response.status === 401 &&
      (
        await fetch(new URL("/api/v0/internal/server-settings", healthUrl(paths)), {
          headers: { authorization: `Bearer ${token}` },
          signal,
        })
      ).ok;
    if (response.status === 404 || legacyRoute)
      return {
        label: "Transcription",
        level: "warn",
        detail:
          "This server does not expose transcription diagnostics. Update the server to configure voice notes.",
      };
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
