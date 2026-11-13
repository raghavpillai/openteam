import { afterEach, describe, expect, test } from "bun:test";
import { createModelSettingsAPI } from "../src/model-settings";
import { modelServer } from "./fixtures/model-server";
import {
  activate,
  edit,
  modelFixture,
  press,
  providerAccessFixture,
  screen,
} from "./fixtures/model-session";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
describe("interactive model editor", () => {
  test("blank secret edit keeps saved key; explicit removal is sent as null", async () => {
    const { session: s, calls } = modelFixture();
    await s.load();
    await press(s, "right");
    await edit(s, "apiKey", "");
    expect(screen(s)).toContain("••••A7z9");
    expect(s.dirty()).toBe(false);
    await edit(s, "language", "fr");
    await activate(s, "save");
    expect(calls.transcription[0]).not.toHaveProperty("apiKey");
    await activate(s, "remove-key");
    expect(s.rows().find((row) => "id" in row && row.id === "remove-key")).toMatchObject({
      kind: "action",
      label: "Undo key deletion",
    });
    expect(screen(s)).toContain("Key will be deleted when you save");
    await activate(s, "remove-key");
    expect(s.transcription).not.toHaveProperty("apiKey");
    await activate(s, "remove-key");
    await activate(s, "save");
    expect(calls.transcription[1]?.apiKey).toBeNull();
    expect(s.savedTranscription?.hasApiKey).toBe(false);
  });
  test("secret editing is masked, errors redact drafts, successful saves drop plaintext", async () => {
    const { session: s, api, calls } = modelFixture();
    await s.load();
    await press(s, "right");
    const secret = "synthetic-private-credential";
    await activate(s, "apiKey");
    s.handle(secret, {});
    expect(screen(s)).not.toContain(secret);
    expect(screen(s)).toContain("••••");
    await press(s, "return");
    const save = api.saveTranscription;
    api.saveTranscription = async () => {
      throw new Error(`Rejected ${secret}`);
    };
    await activate(s, "save");
    expect(screen(s)).not.toContain(secret);
    expect(screen(s)).toContain("REDACTED");
    api.saveTranscription = save;
    await activate(s, "save");
    expect(calls.transcription[0]?.apiKey).toBe(secret);
    expect(s.transcription).not.toHaveProperty("apiKey");
  });
  test("changing endpoint clears new credentials and stops offering the saved key", async () => {
    const { session: s, calls } = modelFixture();
    await s.load();
    await press(s, "right");
    await edit(s, "apiKey", "synthetic-new-key");
    await edit(s, "baseUrl", "http://other.test/v1/");
    expect(s.transcription).not.toHaveProperty("apiKey");
    expect(screen(s)).not.toContain("Saved; blank keeps it");
    await activate(s, "save");
    expect(calls.transcription[0]).not.toHaveProperty("apiKey");
    expect(s.savedTranscription?.hasApiKey).toBe(true);
    expect(screen(s)).toContain("replacement key");
    await activate(s, "remove-key");
    await activate(s, "save");
    expect(calls.transcription[1]?.apiKey).toBeNull();
    expect(s.savedTranscription?.hasApiKey).toBe(false);
  });
});

const settingsFixture = () => {
  const f = modelServer();
  cleanups.push(f.cleanup);
  return { ...f, client: createModelSettingsAPI(f.paths) };
};
describe("interactive model HTTP settings", () => {
  test("retains only a validated four-character suffix from settings responses", async () => {
    const { client, api } = settingsFixture();
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
    const { client, api } = settingsFixture();
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
