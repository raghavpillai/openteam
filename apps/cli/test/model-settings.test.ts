import { afterEach, describe, expect, test } from "bun:test";
import { createModelSettingsAPI } from "../src/model-settings";
import { modelServer } from "./fixtures/model-server";
import { providerAccessFixture } from "./fixtures/model-session";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const fixture = () => {
  const f = modelServer();
  cleanups.push(f.cleanup);
  return { ...f, client: createModelSettingsAPI(f.paths) };
};
describe("interactive model HTTP settings", () => {
  test("preserves subscription/API metadata without retaining extra credential fields", async () => {
    const { client, api } = fixture();
    const catalog = api.catalog;
    api.catalog = async (...args) => ({
      ...(await catalog(...args)),
      providers: providerAccessFixture().map((p) => ({ ...p, apiKey: "synthetic-private-key" })),
    });
    const result = await client.catalog();
    expect(result.providers).toMatchObject(providerAccessFixture());
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
  });
  test("authenticates catalog reads and saves both settings through their own endpoints", async () => {
    const { client, requests, calls } = fixture();
    expect((await client.catalog("example")).models).toHaveLength(2);
    const saved = await client.saveInference({
      providerId: "example",
      modelId: "fast",
      reasoning: "off",
    });
    expect(saved.modelId).toBe("fast");
    const t = await client.transcription();
    expect(t).not.toHaveProperty("apiKey");
    const { hasApiKey, configured, ...draft } = t;
    await client.saveTranscription({ ...draft, model: "speech-large" });
    expect(await client.transcriptionModels(draft)).toContain("speech-large");
    expect((await client.checkTranscription()).level).toBe("pass");
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET ",
      "PATCH /inference",
      "GET /transcription",
      "PUT /transcription",
      "POST /transcription/models",
      "POST /transcription/check",
    ]);
    expect(requests[0]?.provider).toBe("example");
    expect(calls.transcription[0]).not.toHaveProperty("apiKey");
  });
  test.each([401, 403])("HTTP %i points to installation / instance mismatch", async (status) => {
    const { client, state } = fixture();
    state.status = status;
    await expect(client.catalog()).rejects.toThrow("rejected this installation's control token");
  });
  test("failed and malformed save responses never become saved state", async () => {
    const { client, state } = fixture();
    const draft = { providerId: "example", modelId: "fast", reasoning: "off" as const };
    state.status = 503;
    await expect(client.saveInference(draft)).rejects.toThrow("Retry after starting the server");
    state.status = 200;
    state.invalid = true;
    await expect(client.saveInference(draft)).rejects.toThrow("invalid model settings");
    await expect(client.transcription()).rejects.toThrow("invalid model settings");
    await expect(client.catalog()).rejects.toThrow("invalid model settings");
    await expect(client.checkTranscription()).rejects.toThrow("invalid model settings");
  });
  test("cancellation aborts a pending request promptly", async () => {
    const { client, state } = fixture();
    state.delay = 200;
    const controller = new AbortController();
    const pending = client.catalog(undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Could not reach runtime settings");
  });
});
