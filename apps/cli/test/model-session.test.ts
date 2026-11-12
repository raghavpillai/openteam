import { describe, expect, test } from "bun:test";
import {
  activate,
  edit,
  focused,
  modelFixture,
  press,
  screen,
} from "./fixtures/model-session";

describe("interactive model editor", () => {
  test("preselects the first catalog model on a fresh install and persists only on Save", async () => {
    const { session: s, api, calls } = modelFixture();
    const catalog = api.catalog;
    api.catalog = async (...args) => {
      const value = await catalog(...args);
      return {
        ...value,
        inference: { ...value.inference, modelId: "" },
        models: value.models.reverse(),
      };
    };
    await s.load();
    expect(s.inference).toMatchObject({ modelId: "fast", reasoning: "off" });
    expect(s.savedInference?.modelId).toBe("");
    expect(screen(s)).toContain("No model selected");
    expect(calls.inference).toHaveLength(0);
    await activate(s, "provider");
    await activate(s, "provider:example");
    expect(focused(s)).toBe("model:fast");
    await press(s, "escape");
    await activate(s, "save");
    expect(calls.inference).toEqual([{ providerId: "example", modelId: "fast", reasoning: "off" }]);
  });
  test("left/right tabs preserve independent drafts and saves", async () => {
    const { session: s, calls } = modelFixture();
    await s.load();
    await activate(s, "model");
    await activate(s, "model:fast");
    expect(s.inference).toMatchObject({ modelId: "fast", reasoning: "off" });
    await press(s, "right");
    await edit(s, "transcription-model", "speech-large");
    expect(s.dirty(0)).toBe(true);
    expect(s.dirty(1)).toBe(true);
    await activate(s, "save");
    expect(calls.transcription).toHaveLength(1);
    expect(calls.inference).toHaveLength(0);
    await press(s, "left");
    expect(s.inference?.modelId).toBe("fast");
    await activate(s, "save");
    expect(calls.inference[0]?.modelId).toBe("fast");
    expect(s.dirty(0)).toBe(false);
    expect(s.dirty(1)).toBe(false);
    await activate(s, "save");
    expect(calls.inference).toHaveLength(1);
    expect(await activate(s, "done")).toEqual({ type: "complete", value: true });
  });
  test("escape asks before discarding either tab and defaults to keeping edits", async () => {
    const { session: s, calls } = modelFixture();
    await s.load();
    await activate(s, "thinking");
    await press(s, "right");
    expect(await press(s, "escape")).toEqual({ type: "continue" });
    expect(focused(s)).toBe("keep-editing");
    await press(s, "return");
    expect(s.dirty(0)).toBe(true);
    await press(s, "escape");
    expect(await activate(s, "discard")).toEqual({ type: "complete", value: true });
    expect(calls.inference).toHaveLength(0);
  });
  test("save failure preserves draft and reports no successful save", async () => {
    const { session: s, api } = modelFixture();
    await s.load();
    await activate(s, "thinking");
    api.saveInference = async () => {
      throw new Error("The server is unavailable. Retry once it starts.");
    };
    await activate(s, "save");
    expect(s.dirty()).toBe(true);
    expect(s.savedInference?.reasoning).toBe("high");
    expect(screen(s)).toContain("Retry once it starts");
  });
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
