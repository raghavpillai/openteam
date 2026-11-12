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
  test("retains only a validated four-character suffix from settings responses", async () => {
    const { client, api } = fixture();
    const transcription = api.transcription;
    api.transcription = async (...args) => ({
      ...(await transcription(...args)),
      apiKeySuffix: "A7z9",
      apiKey: "synthetic-private-key",
    });
    expect(await client.transcription()).toMatchObject({ apiKeySuffix: "A7z9" });
    expect(await client.transcription()).not.toHaveProperty("apiKey");
    for (const suffix of ["full-secret", "a\u001b[", 1234]) {
      api.transcription = async (...args) => ({
        ...(await transcription(...args)),
        apiKeySuffix: suffix as string,
      });
      await expect(client.transcription()).rejects.toThrow("invalid model settings");
    }
  });
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
});
