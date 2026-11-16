import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptionStore } from "../src/transcription/store";
import { TranscriptionService } from "../src/transcription/service";
import { MAX_VOICE_NOTE_BYTES } from "@openteam/contracts/transcription";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const settings = { enabled: true, provider: "openai-compatible" as const, baseUrl: "http://audio.test:8000/v1", model: "parakeet", language: "en" };
async function store() {
  const root = await mkdtemp(join(tmpdir(), "openteam-transcription-"));
  directories.push(root);
  return new TranscriptionStore(join(root, "transcription.json"), () => "a".repeat(40));
}
const upload = (body: BodyInit, type = "audio/wav") => new Request("http://local", { method: "POST", body, headers: { "content-type": type } });
const audio = () => upload(new Uint8Array(128));
const fakeFetch = (fn: (url: string, init: RequestInit) => Promise<Response> | Response) =>
  ((url: string | URL | Request, init?: RequestInit) => fn(String(url), init ?? {})) as typeof fetch;
const auth = (init: RequestInit) => new Headers(init.headers).get("authorization");

describe("transcription settings and credentials", () => {
  test("encrypted on disk, redacted in views, bound to their endpoint and fail closed", async () => {
    const config = await store();
    expect((await config.view()).configured).toBe(false);
    await expect(config.credentials()).rejects.toMatchObject({ code: "transcription_not_configured" });
    const view = await config.save({ ...settings, apiKey: "test-private-key" });
    expect(view).toMatchObject({ configured: true, hasApiKey: true, apiKeySuffix: "-key" });
    expect(JSON.stringify(view)).not.toContain("test-private-key");
    expect(await readFile(config.path, "utf8")).not.toContain("test-private-key");
    expect((await stat(config.path)).mode & 0o777).toBe(0o600);
    expect((await new TranscriptionStore(config.path, () => "a".repeat(40)).credentials()).apiKey).toBe("test-private-key");
    expect(await new TranscriptionStore(config.path, () => "b".repeat(40)).status()).toBe("invalid");
    await config.save({ ...settings, model: "another" });
    expect((await config.credentials()).apiKey).toBe("test-private-key");
    await expect(config.save({ ...settings, baseUrl: "http://different.test/v1" })).rejects.toThrow("replacement key");
    await config.save({ ...settings, baseUrl: "http://different.test/v1", apiKey: null });
    expect((await config.credentials()).apiKey).toBeNull();
    await writeFile(config.path, "not-json");
    expect(await config.status()).toBe("invalid");
    await config.save({ ...settings, enabled: false });
    expect(await config.status()).toBe("missing");
  });
  test("validates enabled settings and never accepts embedded URL credentials", async () => {
    const config = await store();
    for (const change of [
      { baseUrl: "file:///tmp/audio" }, { baseUrl: "http://user:secret@audio.test/v1" }, { baseUrl: "http://audio.test/v1?key=secret" },
      { model: "" }, { language: "invalid-language" }, { apiKey: "bad\nkey" },
    ]) expect(() => config.save({ ...settings, ...change })).toThrow();
    await expect(config.save({ ...settings, provider: "openai" })).rejects.toThrow("API key");
    expect(await config.status()).toBe("missing");
  });
});

describe("voice-note provider requests", () => {
  test("only admits two concurrent notes and frees capacity after completion", async () => {
    const config = await store();
    await config.save(settings);
    const release: Array<() => void> = [];
    const service = new TranscriptionService(config, fakeFetch(() => new Promise((resolve) => release.push(() => resolve(Response.json({ text: "Done" }))))));
    const pending = [service.transcribe(audio()), service.transcribe(audio())];
    while (release.length < 2) await Bun.sleep(1);
    await expect(service.transcribe(audio())).rejects.toMatchObject({ code: "transcription_busy", status: 429 });
    release.splice(0).forEach((done) => done());
    await Promise.all(pending);
    const next = service.transcribe(audio());
    while (release.length < 1) await Bun.sleep(1);
    release[0]!();
    expect(await next).toEqual({ text: "Done" });
  });
  test("OpenAI-compatible and GPT Transcribe uploads carry server credentials and return only the trimmed text", async () => {
    const config = await store();
    await config.save({ ...settings, apiKey: "private" });
    const compatible = new TranscriptionService(config, fakeFetch(async (url, init) => {
      expect(url).toBe("http://audio.test:8000/v1/audio/transcriptions");
      expect(auth(init)).toBe("Bearer private");
      const form = init.body as FormData;
      expect([form.get("model"), form.get("language"), (form.get("file") as File).size]).toEqual(["parakeet", "en", 128]);
      return Response.json({ text: "  Ship this tomorrow.  ", private: "must not reach clients" });
    }));
    expect(await compatible.transcribe(audio())).toEqual({ text: "Ship this tomorrow." });
    await config.save({ ...settings, provider: "openai", model: "gpt-transcribe", apiKey: "synthetic-openai-key" });
    const gpt = new TranscriptionService(config, fakeFetch((url, init) => {
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      const form = init.body as FormData;
      expect([form.get("response_format"), form.get("language"), form.getAll("languages[]")]).toEqual([null, null, ["en"]]);
      return Response.json({ text: "Current model transcript", languages: [{ code: "en" }] });
    }));
    expect(await gpt.transcribe(audio())).toEqual({ text: "Current model transcript" });
  });
  test("disabled, unsupported, empty and oversized uploads never call the provider", async () => {
    const config = await store();
    let called = 0;
    const service = new TranscriptionService(config, fakeFetch(() => { called++; return Response.json({ text: "bad" }); }));
    await expect(service.transcribe(audio())).rejects.toMatchObject({ code: "transcription_not_configured" });
    await config.save(settings);
    await expect(service.transcribe(upload("bad", "text/plain"))).rejects.toMatchObject({ status: 415 });
    await expect(service.transcribe(upload(""))).rejects.toMatchObject({ code: "empty_audio" });
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_VOICE_NOTE_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();
    } });
    await expect(service.transcribe(upload(stream))).rejects.toMatchObject({ status: 413 });
    expect(called).toBe(0);
  });
  test("provider errors cannot echo secrets, and no speech is a recoverable error", async () => {
    const config = await store();
    await config.save(settings);
    const respond = (response: () => Response) => new TranscriptionService(config, fakeFetch(response)).transcribe(audio());
    await expect(respond(() => Response.json({ error: "secret echoed here" }, { status: 401 }))).rejects.toMatchObject({
      code: "transcription_provider_error", message: "The transcription provider rejected the API key. Check Voice notes settings.",
    });
    await expect(respond(() => Response.json({ text: " " }))).rejects.toMatchObject({ code: "no_speech" });
    await expect(respond(() => Response.json({ output: "something else" }))).rejects.toMatchObject({ code: "invalid_transcription_response" });
  });
  test("diagnostics and model discovery never send audio, persist drafts, or move a stored key to another endpoint", async () => {
    const config = await store();
    let response = () => Response.json({ data: [{ id: "speech-small" }, { id: "speech-large" }, { id: "speech-small" }, { id: "parakeet" }] });
    const authorizations: Array<string | null> = [];
    const service = new TranscriptionService(config, fakeFetch((url, init) => {
      expect(url.endsWith("/models")).toBe(true);
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe("error");
      authorizations.push(auth(init));
      return response();
    }));
    expect((await service.check()).status).toBe("missing");
    expect(authorizations).toEqual([]);
    await config.save({ ...settings, enabled: false, apiKey: "saved-private-key" });
    const before = await readFile(config.path, "utf8");
    expect(await service.models({ ...settings, model: "" })).toEqual({ models: ["parakeet", "speech-large", "speech-small"] });
    await service.models({ ...settings, baseUrl: "http://different.test/v1" });
    await service.models({ ...settings, baseUrl: "http://different.test/v1", apiKey: "draft-private-key" });
    expect(authorizations).toEqual(["Bearer saved-private-key", null, "Bearer draft-private-key"]);
    expect(await readFile(config.path, "utf8")).toBe(before);
    await config.save(settings);
    expect((await service.check()).status).toBe("ready");
    response = () => new Response(null, { status: 404 });
    expect((await service.check()).status).toBe("unverified");
    response = () => new Response(null, { status: 401 });
    expect((await service.check()).level).toBe("fail");
  });
});

describe("Deepgram transcription", () => {
  const deepgram = { ...settings, provider: "deepgram" as const, baseUrl: "https://api.deepgram.com/v1", model: "nova-3", language: "", apiKey: "synthetic-deepgram-key" };
  const { apiKey: _key, ...keyless } = deepgram;
  const catalog = { stt: [
    { name: "general", canonical_name: "nova-3-general", architecture: "nova-3", uuid: "model-uuid", batch: true },
    { name: "general", canonical_name: "nova-3-general", architecture: "nova-3", batch: true },
    { name: "general", canonical_name: "nova-2-general", architecture: "nova-2", batch: true },
    { name: "medical", canonical_name: "nova-3-medical", architecture: "nova-3", batch: true },
    { name: "flux-general-en", canonical_name: "flux-general-en", batch: false },
  ], tts: [{ name: "aura-2" }] };

  test("requires its own key, pins its endpoint, and uploads raw audio with detected or fixed language", async () => {
    const config = await store();
    await config.save({ ...settings, apiKey: "synthetic-custom-key" });
    await expect(config.save(keyless)).rejects.toThrow("replacement key");
    await expect(config.discoveryCredentials(keyless)).rejects.toThrow("Deepgram API key");
    expect(await config.save({ ...deepgram, baseUrl: "https://different.test/v1" })).toMatchObject({ baseUrl: deepgram.baseUrl });
    const recording = new Uint8Array(128).fill(42);
    for (const language of ["", "fr"]) {
      await config.save({ ...keyless, language });
      const service = new TranscriptionService(config, fakeFetch(async (url, init) => {
        const endpoint = new URL(url);
        expect(`${endpoint.origin}${endpoint.pathname}`).toBe(`${deepgram.baseUrl}/listen`);
        expect(Object.fromEntries(endpoint.searchParams)).toEqual({ model: "nova-3", smart_format: "true", ...(language ? { language } : { detect_language: "true" }) });
        expect(auth(init)).toBe(`Token ${deepgram.apiKey}`);
        expect(new Uint8Array(await (init.body as Blob).arrayBuffer())).toEqual(recording);
        return Response.json({ results: { channels: [{ alternatives: [{ transcript: "  Hello from Deepgram.  " }, { transcript: "Wrong alternative" }] }] } });
      }));
      expect(await service.transcribe(upload(recording))).toEqual({ text: "Hello from Deepgram." });
    }
  });

  test("browses only batch speech models and checks the key, not just the public catalog", async () => {
    const config = await store();
    await config.save(deepgram);
    let tokenStatus = 200;
    const urls: string[] = [];
    const service = new TranscriptionService(config, fakeFetch((url, init) => {
      urls.push(url);
      expect(auth(init)).toBe(`Token ${deepgram.apiKey}`);
      expect(init.body).toBeUndefined();
      if (url === `${deepgram.baseUrl}/auth/token`) return tokenStatus === 200 ? Response.json({ api_key: deepgram.apiKey }) : new Response(deepgram.apiKey, { status: tokenStatus });
      return Response.json(catalog);
    }));
    expect(await service.models(keyless)).toEqual({ models: ["nova-2-general", "nova-3-general", "nova-3-medical"] });
    for (const [model, status] of [["nova-3", "ready"], ["model-uuid", "ready"], ["nova-4", "unverified"], ["flux-general-en", "unverified"]] as const) {
      await config.save({ ...keyless, model });
      expect((await service.check()).status).toBe(status);
    }
    tokenStatus = 401; urls.length = 0;
    const check = await service.check();
    expect(check).toMatchObject({ level: "fail", status: "unavailable" });
    expect(check.detail).not.toContain(deepgram.apiKey);
    expect(urls).toEqual([`${deepgram.baseUrl}/auth/token`]);
  });

  test.each([401, 429])("redacts HTTP %i transcription and diagnostic failures", async (status) => {
    const config = await store();
    await config.save(deepgram);
    const service = new TranscriptionService(config, fakeFetch(() => new Response(deepgram.apiKey, { status })));
    await expect(service.transcribe(audio())).rejects.toMatchObject({ code: "transcription_provider_error", status: status === 429 ? 429 : 502 });
    const check = await service.check();
    expect(check.level).toBe("fail");
    expect(check.detail).not.toContain(deepgram.apiKey);
  });
});
