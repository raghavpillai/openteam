import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvironment, parseEnvironment } from "../../src/config";
import { installStack } from "./harness";
import { modelFixture } from "./model-session";

export const modelServer = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-model-ui-"));
  const environment = createEnvironment({ version: "1.2.3" });
  const token = parseEnvironment(environment).get("OPENTEAM_CONTROL_TOKEN");
  const fixture = modelFixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response(null, { status: 401 });
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v0/internal/server-settings", "");
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
  const { paths } = installStack(directory, {
    environment,
    apiPort: server.port,
    compose: "name: model-test\nservices: {}\n",
  });
  return {
    ...fixture,
    paths,
    cleanup: () => {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
};
