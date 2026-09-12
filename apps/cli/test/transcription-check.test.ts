import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installationPaths } from "../src/config";
import { checkTranscription } from "../src/transcription-check";
import { renderDoctor } from "../src/doctor-ui";

test("doctor checks transcription through the authenticated server and reports optional setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-transcription-doctor-"));
  const token = "private-installation-token";
  let response = Response.json({
    level: "warn",
    status: "missing",
    detail: "Not configured; voice notes are disabled.",
  });
  let calls = 0;
  let legacy = false;
  let validControlToken = true;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      calls++;
      if (new URL(request.url).pathname === "/api/v0/internal/server-settings") {
        return new Response(null, { status: validControlToken ? 200 : 401 });
      }
      expect(new URL(request.url).pathname).toBe(
        "/api/v0/internal/server-settings/transcription/check"
      );
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      return legacy ? new Response(null, { status: 401 }) : response.clone();
    },
  });
  try {
    const paths = installationPaths(directory);
    await writeFile(
      paths.environment,
      `OPENTEAM_CONTROL_TOKEN=${token}\nOPENTEAM_API_PORT=${server.port}\n`
    );
    const missing = await checkTranscription(paths);
    expect(missing).toMatchObject({ label: "Transcription", level: "warn" });
    const rendered = renderDoctor(
      { installed: true, ok: true, checks: [missing] },
      { color: false }
    );
    expect(rendered).toContain("VOICE NOTES");
    expect(rendered).not.toContain(token);
    response = Response.json({
      level: "fail",
      detail: "The transcription provider rejected the API key.",
    });
    expect((await checkTranscription(paths)).level).toBe("fail");
    response = new Response("Old server", { status: 404 });
    expect(await checkTranscription(paths)).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("Update the server"),
    });
    response = Response.json({ level: "invalid", detail: "bad" });
    expect((await checkTranscription(paths)).level).toBe("fail");
    expect(calls).toBe(4);
    legacy = true;
    expect(await checkTranscription(paths)).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("Update the server"),
    });
    validControlToken = false;
    expect((await checkTranscription(paths)).level).toBe("fail");
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
