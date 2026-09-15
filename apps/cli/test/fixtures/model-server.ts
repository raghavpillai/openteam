import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironment,
  installationPaths,
  parseEnvironment,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../../src/config";
import { modelFixture } from "./model-session";

export const modelServer = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-model-ui-"));
  const paths = installationPaths(directory);
  const environment = createEnvironment({ version: "1.2.3" });
  const token = parseEnvironment(environment).get("OPENTEAM_CONTROL_TOKEN");
  const fixture = modelFixture();
  const requests: Array<{ method: string; path: string; provider: string | null }> = [];
  const state = { status: 200, invalid: false, delay: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response(null, { status: 401 });
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v0/internal/server-settings", "");
      requests.push({ method: request.method, path, provider: url.searchParams.get("provider") });
      if (state.delay) await Bun.sleep(state.delay);
      if (state.status !== 200)
        return Response.json(
          { error: { message: "Settings unavailable. Retry after starting the server." } },
          { status: state.status }
        );
      if (state.invalid) return Response.json({ apiKey: "unexpected-response-secret" });
      if (path === "" && request.method === "GET")
        return Response.json(
          await fixture.api.catalog(url.searchParams.get("provider") ?? undefined)
        );
      if (path === "/inference" && request.method === "PATCH")
        return Response.json(await fixture.api.saveInference(await request.json()));
      if (path === "/transcription" && request.method === "GET")
        return Response.json({
          ...(await fixture.api.transcription()),
          apiKey: "unexpected-response-secret",
        });
      if (path === "/transcription" && request.method === "PUT")
        return Response.json(await fixture.api.saveTranscription(await request.json()));
      if (path === "/transcription/check" && request.method === "POST")
        return Response.json(await fixture.api.checkTranscription());
      if (path === "/transcription/models" && request.method === "POST")
        return Response.json({
          models: await fixture.api.transcriptionModels(await request.json()),
        });
      return new Response(null, { status: 404 });
    },
  });
  writeFileAtomic(
    paths.environment,
    replaceEnvironmentValue(environment, "OPENTEAM_API_PORT", String(server.port))
  );
  writeFileAtomic(paths.compose, "name: model-test\nservices: {}\n");
  const now = new Date().toISOString();
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "example/test",
    version: "1.2.3",
    composeUrl: "https://example.test/compose.yaml",
    installedAt: now,
    updatedAt: now,
  });
  return {
    ...fixture,
    paths,
    requests,
    state,
    cleanup: () => {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
};
