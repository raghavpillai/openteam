import { describe, expect, test } from "bun:test";
import { terminalTextWidth } from "../src/terminal";
import { clampViewport } from "../src/ui";
import {
  activate,
  edit,
  focus,
  focused,
  modelFixture,
  press,
  providerAccessFixture,
  screen,
} from "./fixtures/model-session";

describe("interactive model editor", () => {
  test("connection cancellation preserves both drafts and returns to provider choices", async () => {
    const { session: s, calls } = modelFixture();
    await s.load();
    s.inference!.reasoning = "medium";
    s.transcription!.model = "unsaved-speech-model";
    await activate(s, "provider");
    await activate(s, "provider:offline");
    await s.providerConnected(undefined, undefined, true);
    expect(s.view().title).toBe("Choose a provider");
    expect(screen(s)).toContain("Connection cancelled");
    expect(s.inference!.reasoning).toBe("medium");
    expect(s.transcription!.model).toBe("unsaved-speech-model");
    expect(calls.inference).toHaveLength(0);
    expect(calls.transcription).toHaveLength(0);
  });
  test("a new connection opens that provider's models without saving the selection", async () => {
    const { session: s, api, calls } = modelFixture();
    await s.load();
    const catalog = api.catalog;
    api.catalog = async (...args) => {
      const value = await catalog(...args);
      value.providers = value.providers.map((provider) => ({ ...provider, connected: true }));
      return value;
    };
    await s.providerConnected(undefined, "offline");
    expect(s.view().title).toBe("Choose an inference model");
    expect(s.inference!.providerId).toBe("offline");
    expect(screen(s)).toContain("offline-model");
    expect(s.savedInference!.providerId).toBe("example");
    expect(calls.inference).toHaveLength(0);
  });
  test("groups subscriptions, APIs and custom endpoints, and focuses the active connection", async () => {
    const { session: s, api } = modelFixture();
    const catalog = api.catalog;
    api.catalog = async (...args) => ({
      ...(await catalog(...args)),
      inference: { providerId: "openai", modelId: "reasoner", reasoning: "high" },
      providers: providerAccessFixture(),
    });
    await s.load();
    await activate(s, "provider");
    expect(
      s
        .rows()
        .filter((r) => r.kind === "heading")
        .map((r) => r.text)
    ).toEqual(["Subscriptions", "APIs", "Custom endpoints"]);
    expect(focused(s)).toBe("provider:openai");
    expect(screen(s)).not.toContain("Sign-in needed");
    for (const width of [24, 40, 60, 90, 110]) {
      const frame = s.frame(width, false);
      expect(
        [...frame.header, ...frame.body, ...frame.footer].every(
          (line) => terminalTextWidth(line) <= width
        )
      ).toBe(true);
    }
    const compact = s.frame(40, false);
    const visible = clampViewport(
      compact.body,
      compact.cursorLine,
      24 - compact.header.length - compact.footer.length - 1,
      0,
      false,
      compact.cursorEndLine
    ).lines.join("\n");
    expect(visible).toContain("❯ OpenAI");
    expect(visible).toContain("Connected");
    expect(visible).toContain("API key access");
    expect(await activate(s, "provider:openai-codex")).toEqual({
      type: "complete",
      value: { connectProvider: "openai-codex", authType: "oauth" },
    });
    expect(await activate(s, "provider:anthropic")).toEqual({
      type: "complete",
      value: { connectProvider: "anthropic", authType: "api_key" },
    });
    expect(await activate(s, "provider:claude-code")).toEqual({
      type: "complete",
      value: { connectProvider: "claude-code", authType: "oauth" },
    });
  });
  test("an API connection does not mark a subscription connected or expose its model count", async () => {
    const { session: s, api } = modelFixture();
    const catalog = api.catalog;
    api.catalog = async (...args) => ({
      ...(await catalog(...args)),
      providers: providerAccessFixture().map((p) =>
        p.id === "anthropic" ? { ...p, connected: true, authType: "api_key", modelCount: 38 } : p
      ),
    });
    await s.load();
    await activate(s, "provider");
    const subscriptions = s
      .rows()
      .find((r) => r.kind === "option" && r.id === "provider:claude-code");
    expect(subscriptions).toMatchObject({ badge: "Connect subscription" });
    expect(JSON.stringify(subscriptions)).not.toContain("38");
    expect(
      s.rows().find((r) => r.kind === "option" && r.id === "provider:anthropic")
    ).toMatchObject({ badge: "Connected" });
    expect(await activate(s, "provider:claude-code")).toEqual({
      type: "complete",
      value: { connectProvider: "claude-code", authType: "oauth" },
    });
  });
  test("catalogs render server-provided built-ins and label OpenAI API and subscription access", async () => {
    const { session: s, api } = modelFixture();
    const catalog = api.catalog;
    api.catalog = async (...args) => ({
      ...(await catalog(...args)),
      providers: [
        { id: "nvidia", name: "NVIDIA", custom: false, connected: false, modelCount: 38 },
        { id: "openai", name: "OpenAI", custom: false, connected: false, modelCount: 38 },
        {
          id: "openai-codex",
          name: "OpenAI Codex",
          custom: false,
          connected: false,
          modelCount: 20,
        },
        {
          id: "my-nvidia",
          name: "My NVIDIA endpoint",
          custom: true,
          connected: false,
          modelCount: 38,
        },
      ],
    });
    await s.load();
    await activate(s, "provider");
    expect(s.rows().some((r) => r.kind === "option" && r.id === "provider:nvidia")).toBe(true);
    expect(s.rows().some((r) => r.kind === "option" && r.id === "provider:my-nvidia")).toBe(true);
    expect(s.rows().find((r) => r.kind === "option" && r.id === "provider:openai")).toMatchObject({
      badge: "Add API key",
    });
    expect(
      s.rows().find((r) => r.kind === "option" && r.id === "provider:openai-codex")
    ).toMatchObject({ badge: "Connect subscription" });
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
  test("model picker supports type-to-search, empty results, and selection", async () => {
    const { session: s } = modelFixture();
    await s.load();
    await activate(s, "model");
    s.handle("missing", {});
    expect(screen(s)).toContain("No models or providers match");
    await press(s, "u", { ctrl: true });
    s.handle("fast", {});
    await press(s, "return");
    expect(focused(s)).toBe("model:fast");
    await press(s, "return");
    expect(s.inference?.modelId).toBe("fast");
    await activate(s, "provider");
    await activate(s, "provider:example");
    expect(s.inference?.modelId).toBe("fast");
  });
  test("unconnected providers open sign-in before showing models and preserve drafts", async () => {
    const { session: s, calls, api } = modelFixture();
    await s.load();
    await press(s, "right");
    await edit(s, "language", "fr");
    await press(s, "left");
    await activate(s, "provider");
    expect(await activate(s, "provider:offline")).toEqual({
      type: "complete",
      value: { connectProvider: "offline" },
    });
    expect(calls.inference).toHaveLength(0);
    expect(s.inference?.providerId).toBe("example");
    const catalog = api.catalog;
    api.catalog = async (...args) => {
      const result = await catalog(...args);
      result.providers = result.providers.map((p) => ({ ...p, connected: true }));
      return result;
    };
    await s.providerConnected();
    expect(s.transcription?.language).toBe("fr");
    expect(s.dirty(1)).toBe(true);
    await activate(s, "provider:offline");
    expect(s.view().title).toBe("Choose an inference model");
    await activate(s, "model:offline-model");
    await activate(s, "save");
    expect(calls.inference[0]?.providerId).toBe("offline");
  });
  test("model discovery errors offer reconnection and stay visible inside the model picker", async () => {
    const { session: s, api } = modelFixture();
    const catalog = api.catalog;
    api.catalog = async (...args) => {
      const value = await catalog(...args);
      value.models = [];
      value.providers[0] = {
        ...value.providers[0]!,
        modelCount: 0,
        modelStatus: "unavailable",
        modelMessage: "Reconnect this provider to load its chat models.",
      };
      return value;
    };
    await s.load();
    expect(await activate(s, "reconnect-provider")).toEqual({
      type: "complete",
      value: { connectProvider: "example" },
    });
    await activate(s, "provider");
    await activate(s, "provider:example");
    expect(screen(s)).toContain("Reconnect this provider");
  });
  test("thinking cycles only for models that support it", async () => {
    const { session: s } = modelFixture();
    await s.load();
    await activate(s, "thinking");
    expect(s.inference?.reasoning).toBe("xhigh");
    await activate(s, "model");
    await activate(s, "model:fast");
    await activate(s, "thinking");
    expect(s.inference?.reasoning).toBe("off");
    expect(screen(s)).toContain("does not support a thinking level");
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
  test("one unavailable tab does not prevent editing the other and supports retry", async () => {
    const { session: s, api } = modelFixture();
    const catalog = api.catalog;
    api.catalog = async () => {
      throw new Error("Start the inference service and retry.");
    };
    await s.load();
    expect(screen(s)).toContain("Retry loading settings");
    await press(s, "right");
    await edit(s, "language", "fr");
    await activate(s, "save");
    expect(s.savedTranscription?.language).toBe("fr");
    await press(s, "left");
    api.catalog = catalog;
    await activate(s, "reload");
    expect(s.savedInference?.modelId).toBe("reasoner");
  });
  test("blank secret edit keeps saved key; explicit removal is sent as null", async () => {
    const { session: s, calls } = modelFixture();
    await s.load();
    await press(s, "right");
    await edit(s, "apiKey", "");
    expect(s.dirty()).toBe(false);
    await edit(s, "language", "fr");
    await activate(s, "save");
    expect(calls.transcription[0]).not.toHaveProperty("apiKey");
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
    expect(s.savedTranscription?.hasApiKey).toBe(false);
  });
  test("invalid endpoint and language stay in edit mode; escape leaves settings untouched", async () => {
    const { session: s } = modelFixture();
    await s.load();
    await press(s, "right");
    await edit(s, "baseUrl", "https://user:secret@audio.test/v1");
    expect(s.view().mode).toBe("edit");
    expect(screen(s)).toContain("without credentials");
    await press(s, "escape");
    expect(s.dirty()).toBe(false);
    await edit(s, "language", "English");
    expect(screen(s)).toContain("language code");
    await press(s, "escape");
    expect(s.transcription?.language).toBe("");
  });
  test("OpenAI needs its own key and connection testing requires saved settings", async () => {
    const { session: s, calls } = modelFixture();
    await s.load();
    await press(s, "right");
    await activate(s, "transcription-provider");
    await activate(s, "save");
    expect(screen(s)).toContain("Chat sign-in cannot be used");
    expect(calls.transcription).toHaveLength(0);
    await activate(s, "test");
    expect(screen(s)).toContain("Save transcription before testing");
    expect(calls.checks).toBe(0);
    await edit(s, "apiKey", "synthetic-openai-key");
    await activate(s, "save");
    await activate(s, "test");
    expect(calls.checks).toBe(1);
    expect(screen(s)).toContain("Send a voice note");
  });
  test("transcription discovery reads drafts without saving and supports searchable selection", async () => {
    const { session: s, calls } = modelFixture();
    await s.load();
    await press(s, "right");
    await edit(s, "baseUrl", "http://new.test/v1");
    await activate(s, "browse-transcription");
    expect(calls.discovery[0]?.baseUrl).toBe("http://new.test/v1");
    expect(calls.transcription).toHaveLength(0);
    s.handle("large", {});
    await press(s, "return");
    await press(s, "return");
    expect(s.transcription?.model).toBe("speech-large");
    expect(calls.transcription).toHaveLength(0);
    await activate(s, "save");
    expect(calls.transcription[0]?.model).toBe("speech-large");
  });
  test("discovery errors keep manual model entry available", async () => {
    const { session: s, api } = modelFixture();
    await s.load();
    await press(s, "right");
    api.transcriptionModels = async () => {
      throw new Error("Enter its transcription model ID manually.");
    };
    await activate(s, "browse-transcription");
    expect(screen(s)).toContain("model ID manually");
    await edit(s, "transcription-model", "manual-model");
    expect(s.transcription?.model).toBe("manual-model");
  });
  test.each([
    24, 40, 60, 76, 90, 110,
  ])("both tabs fit %i columns without leaking terminal controls", async (width) => {
    const { session: s } = modelFixture();
    await s.load();
    for (let tab = 0; tab < 2; tab++) {
      for (const line of screen(s, width).split("\n"))
        expect(terminalTextWidth(line)).toBeLessThanOrEqual(width);
      await press(s, "right");
    }
    await focus(s, "model");
    expect(await press(s, "c", { ctrl: true })).toEqual({ type: "interrupt" });
  });
});
