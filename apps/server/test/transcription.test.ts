import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptionStore } from "../src/transcription/store";
import { TranscriptionService } from "../src/transcription/service";
import { MAX_VOICE_NOTE_BYTES } from "@openteam/contracts/transcription";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const settings = {
  enabled: true,
  provider: "openai-compatible" as const,
  baseUrl: "http://audio.test:8000/v1",
  model: "parakeet",
  language: "en",
};
async function store() {
  const root = await mkdtemp(join(tmpdir(), "openteam-transcription-"));
  directories.push(root);
  return new TranscriptionStore(join(root, "transcription.json"), () => "a".repeat(40));
}
const audio = (signal?: AbortSignal) =>
  new Request("http://openteam/api/transcriptions", {
    method: "POST",
    body: new Uint8Array(128),
    headers: { "content-type": "audio/wav" },
    signal,
  });
const fakeFetch = (fn: (url: string, init: RequestInit) => Promise<Response> | Response) =>
  ((url: string | URL | Request, init?: RequestInit) =>
    fn(String(url), init ?? {})) as typeof fetch;

describe("transcription settings and credentials", () => {
  test("disabled by default, encrypted on disk, redacted in views, usable after restart", async () => {
    const config = await store();
    expect((await config.view()).configured).toBe(false);
    await expect(config.credentials()).rejects.toMatchObject({
      code: "transcription_not_configured",
    });
    const view = await config.save({ ...settings, apiKey: "test-private-key" });
    expect(view.configured).toBe(true);
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeySuffix).toBe("-key");
    expect(JSON.stringify(view)).not.toContain("test-private-key");
    expect(await readFile(config.path, "utf8")).not.toContain("test-private-key");
    expect((await stat(config.path)).mode & 0o777).toBe(0o600);
    expect(
      (await new TranscriptionStore(config.path, () => "a".repeat(40)).credentials()).apiKey
    ).toBe("test-private-key");
    await config.save({ ...settings, model: "another" });
    expect((await config.credentials()).apiKey).toBe("test-private-key");
    await expect(config.save({ ...settings, baseUrl: "http://different.test/v1" })).rejects.toThrow(
      "replacement key"
    );
    expect((await config.credentials()).apiKey).toBe("test-private-key");
    await config.save({ ...settings, baseUrl: "http://different.test/v1", apiKey: null });
    expect((await config.credentials()).apiKey).toBeNull();
    expect((await config.view()).apiKeySuffix).toBeNull();
  });
  test("validates enabled settings and never accepts embedded URL credentials", async () => {
    const config = await store();
    for (const change of [
      { baseUrl: "file:///tmp/audio" },
      { baseUrl: "http://user:secret@audio.test/v1" },
      { baseUrl: "http://audio.test/v1?key=secret" },
      { model: "" },
      { language: "invalid-language" },
      { apiKey: "bad\nkey" },
    ]) {
      expect(() => config.save({ ...settings, ...change })).toThrow();
    }
    await expect(config.save({ ...settings, provider: "openai" })).rejects.toThrow("API key");
    expect(await config.status()).toBe("missing");
  });
  test("corrupt settings and changed encryption keys fail closed and can be replaced", async () => {
    const config = await store();
    await config.save({ ...settings, apiKey: "test-private-key" });
    expect(await new TranscriptionStore(config.path, () => "b".repeat(40)).status()).toBe(
      "invalid"
    );
    await writeFile(config.path, "not-json");
    expect(await config.status()).toBe("invalid");
    await config.save(settings);
    expect(await config.status()).toBe("configured");
    await config.save({ ...settings, enabled: false });
    expect(await config.status()).toBe("missing");
  });
});

describe("voice-note provider requests", () => {
  test("only admits two concurrent notes and frees capacity after completion", async () => {
    const config = await store();
    await config.save(settings);
    const release: Array<() => void> = [];
    const service = new TranscriptionService(
      config,
      fakeFetch(
        () => new Promise((resolve) => release.push(() => resolve(Response.json({ text: "Done" }))))
      )
    );
    const first = service.transcribe(audio());
    const second = service.transcribe(audio());
    while (release.length < 2) await Bun.sleep(1);
    await expect(service.transcribe(audio())).rejects.toMatchObject({
      code: "transcription_busy",
      status: 429,
    });
    release.splice(0).forEach((done) => done());
    await Promise.all([first, second]);
    const next = service.transcribe(audio());
    while (release.length < 1) await Bun.sleep(1);
    release[0]!();
    expect(await next).toEqual({ text: "Done" });
  });
  test("forwards a multipart recording with server credentials and normalizes the transcript", async () => {
    const config = await store();
    await config.save({ ...settings, apiKey: "private" });
    const service = new TranscriptionService(
      config,
      fakeFetch(async (url, init) => {
        expect(url).toBe("http://audio.test:8000/v1/audio/transcriptions");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer private");
        const form = init.body as FormData;
        expect(form.get("model")).toBe("parakeet");
        expect(form.get("language")).toBe("en");
        expect((form.get("file") as File).size).toBe(128);
        return Response.json({
          text: "  Ship this tomorrow.  ",
          private: "must not reach clients",
        });
      })
    );
    expect(await service.transcribe(audio())).toEqual({ text: "Ship this tomorrow." });
  });
  test("disabled, unsupported, empty, and oversized uploads never call the provider", async () => {
    const config = await store();
    let called = 0;
    const service = new TranscriptionService(
      config,
      fakeFetch(() => {
        called++;
        return Response.json({ text: "bad" });
      })
    );
    await expect(service.transcribe(audio())).rejects.toMatchObject({
      code: "transcription_not_configured",
    });
    await config.save(settings);
    await expect(
      service.transcribe(
        new Request("http://local", {
          method: "POST",
          body: "bad",
          headers: { "content-type": "text/plain" },
        })
      )
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      service.transcribe(
        new Request("http://local", {
          method: "POST",
          body: "",
          headers: { "content-type": "audio/wav" },
        })
      )
    ).rejects.toMatchObject({ code: "empty_audio" });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_VOICE_NOTE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    await expect(
      service.transcribe(
        new Request("http://local", {
          method: "POST",
          body: stream,
          headers: { "content-type": "audio/wav" },
        })
      )
    ).rejects.toMatchObject({ status: 413 });
    expect(called).toBe(0);
  });
  test("provider errors cannot echo secrets, and no speech is a recoverable error", async () => {
    const config = await store();
    await config.save(settings);
    const denied = new TranscriptionService(
      config,
      fakeFetch(() => Response.json({ error: "secret echoed here" }, { status: 401 }))
    );
    await expect(denied.transcribe(audio())).rejects.toMatchObject({
      code: "transcription_provider_error",
      message: "The transcription provider rejected the API key. Check Voice notes settings.",
    });
    const empty = new TranscriptionService(
      config,
      fakeFetch(() => Response.json({ text: " " }))
    );
    await expect(empty.transcribe(audio())).rejects.toMatchObject({ code: "no_speech" });
    const malformed = new TranscriptionService(
      config,
      fakeFetch(() => Response.json({ output: "something else" }))
    );
    await expect(malformed.transcribe(audio())).rejects.toMatchObject({
      code: "invalid_transcription_response",
    });
  });
  test("diagnostics distinguish missing, listed, discovery unsupported, and auth failure without sending audio", async () => {
    const config = await store();
    let calls = 0;
    let response = Response.json({ data: [{ id: "parakeet" }] });
    const service = new TranscriptionService(
      config,
      fakeFetch((url, init) => {
        expect(url.endsWith("/models")).toBe(true);
        expect(init.body).toBeUndefined();
        calls++;
        return response;
      })
    );
    expect((await service.check()).status).toBe("missing");
    expect(calls).toBe(0);
    await config.save(settings);
    expect((await service.check()).status).toBe("ready");
    response = new Response(null, { status: 404 });
    expect((await service.check()).status).toBe("unverified");
    response = new Response(null, { status: 401 });
    expect((await service.check()).level).toBe("fail");
  });
});

describe("transcription model discovery", () => {
  test("uses draft settings without enabling transcription or modifying its file", async () => {
    const config = await store();
    await config.save({ ...settings, enabled: false, apiKey: "saved-private-key" });
    const before = await readFile(config.path, "utf8");
    const service = new TranscriptionService(
      config,
      fakeFetch((url, init) => {
        expect(url).toBe(`${settings.baseUrl}/models`);
        expect(init.body).toBeUndefined();
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer saved-private-key");
        return Response.json({
          data: [{ id: "speech-small" }, { id: "speech-large" }, { id: "speech-small" }],
        });
      })
    );
    expect(await service.models({ ...settings, model: "", enabled: false })).toEqual({
      models: ["speech-large", "speech-small"],
    });
    expect(await readFile(config.path, "utf8")).toBe(before);
    expect((await config.view()).enabled).toBe(false);
  });
  test("never transfers a stored key to another endpoint; explicit draft keys do not persist", async () => {
    const config = await store();
    await config.save({ ...settings, apiKey: "saved-private-key" });
    const authorizations: Array<string | null> = [];
    const service = new TranscriptionService(
      config,
      fakeFetch((_url, init) => {
        authorizations.push(new Headers(init.headers).get("authorization"));
        return Response.json({ data: [] });
      })
    );
    await service.models({ ...settings, baseUrl: "http://different.test/v1" });
    await service.models({
      ...settings,
      baseUrl: "http://different.test/v1",
      apiKey: "draft-private-key",
    });
    await service.models({ ...settings, apiKey: null });
    expect(authorizations).toEqual([null, "Bearer draft-private-key", null]);
    expect((await config.credentials()).apiKey).toBe("saved-private-key");
  });
});

describe("Deepgram transcription", () => {
  const deepgram = {
    ...settings,
    provider: "deepgram" as const,
    baseUrl: "https://api.deepgram.com/v1",
    model: "nova-3",
    language: "",
    apiKey: "synthetic-deepgram-key",
  };
  const catalog = {
    stt: [
      {
        name: "general",
        canonical_name: "nova-3-general",
        architecture: "nova-3",
        uuid: "model-uuid",
        batch: true,
      },
      { name: "general", canonical_name: "nova-3-general", architecture: "nova-3", batch: true },
      { name: "general", canonical_name: "nova-2-general", architecture: "nova-2", batch: true },
      { name: "medical", canonical_name: "nova-3-medical", architecture: "nova-3", batch: true },
      { name: "flux-general-en", canonical_name: "flux-general-en", batch: false },
    ],
    tts: [{ name: "aura-2" }],
  };

  test("requires its own key, pins its endpoint, and never inherits another provider's key", async () => {
    const config = await store();
    await config.save({ ...settings, apiKey: "synthetic-custom-key" });
    const { apiKey: _key, ...draft } = deepgram;
    await expect(config.save(draft)).rejects.toThrow("replacement key");
    await expect(config.discoveryCredentials(draft)).rejects.toThrow("Deepgram API key");
    const view = await config.save({ ...deepgram, baseUrl: "https://different.test/v1" });
    expect(view).toMatchObject({ configured: true, hasApiKey: true, baseUrl: deepgram.baseUrl });
  });

  test.each(["", "fr"])("uploads raw audio with native authentication and language %j", async (language) => {
    const config = await store();
    await config.save({ ...deepgram, language });
    const recording = new Uint8Array(128).fill(42);
    const service = new TranscriptionService(
      config,
      fakeFetch(async (url, init) => {
        const endpoint = new URL(url);
        expect(`${endpoint.origin}${endpoint.pathname}`).toBe(`${deepgram.baseUrl}/listen`);
        expect(endpoint.searchParams.get("model")).toBe("nova-3");
        expect(endpoint.searchParams.get("smart_format")).toBe("true");
        expect(endpoint.searchParams.get("language")).toBe(language || null);
        expect(endpoint.searchParams.get("detect_language")).toBe(language ? null : "true");
        expect(new Headers(init.headers).get("authorization")).toBe(`Token ${deepgram.apiKey}`);
        expect(new Headers(init.headers).get("content-type")).toBe("audio/wav");
        expect(new Uint8Array(await (init.body as Blob).arrayBuffer())).toEqual(recording);
        return Response.json({
          results: {
            channels: [
              {
                alternatives: [
                  { transcript: "  Hello from Deepgram.  " },
                  { transcript: "Wrong alternative" },
                ],
              },
            ],
          },
        });
      })
    );
    expect(
      await service.transcribe(
        new Request("http://local", {
          method: "POST",
          body: recording,
          headers: { "content-type": "audio/wav" },
        })
      )
    ).toEqual({ text: "Hello from Deepgram." });
  });

  test("browses only batch speech models and checks discovery without sending audio", async () => {
    const config = await store();
    await config.save(deepgram);
    const before = await readFile(config.path, "utf8");
    const service = new TranscriptionService(
      config,
      fakeFetch((url, init) => {
        expect(new Headers(init.headers).get("authorization")).toBe(`Token ${deepgram.apiKey}`);
        expect(init.body).toBeUndefined();
        if (url === `${deepgram.baseUrl}/auth/token`)
          return Response.json({ api_key: deepgram.apiKey });
        expect(url).toBe(`${deepgram.baseUrl}/models`);
        return Response.json(catalog);
      })
    );
    const { apiKey: _key, ...draft } = deepgram;
    expect(await service.models(draft)).toEqual({
      models: ["nova-2-general", "nova-3-general", "nova-3-medical"],
    });
    expect(await readFile(config.path, "utf8")).toBe(before);
    expect((await service.check()).status).toBe("ready");
    await config.save({ ...draft, model: "model-uuid" });
    expect((await service.check()).status).toBe("ready");
    await config.save({ ...draft, model: "nova-4" });
    expect((await service.check()).status).toBe("unverified");
    await config.save({ ...draft, model: "flux-general-en" });
    expect((await service.check()).status).toBe("unverified");
  });

  test("rejects an invalid key even when the public model catalog is reachable", async () => {
    const config = await store();
    await config.save(deepgram);
    const urls: string[] = [];
    const service = new TranscriptionService(
      config,
      fakeFetch((url, init) => {
        urls.push(url);
        expect(init.body).toBeUndefined();
        return url.endsWith("/auth/token")
          ? new Response(deepgram.apiKey, { status: 401 })
          : Response.json(catalog);
      })
    );
    const check = await service.check();
    expect(check).toMatchObject({ level: "fail", status: "unavailable" });
    expect(check.detail).not.toContain(deepgram.apiKey);
    expect(urls).toEqual([`${deepgram.baseUrl}/auth/token`]);
  });

  test.each([401, 429])("redacts HTTP %i transcription and diagnostic failures", async (status) => {
    const config = await store();
    await config.save(deepgram);
    const service = new TranscriptionService(
      config,
      fakeFetch(() => new Response(deepgram.apiKey, { status }))
    );
    await expect(service.transcribe(audio())).rejects.toMatchObject({
      code: "transcription_provider_error",
      status: status === 429 ? 429 : 502,
    });
    const check = await service.check();
    expect(check.level).toBe("fail");
    expect(check.detail).not.toContain(deepgram.apiKey);
  });
});

describe("GPT Transcribe requests", () => {
  test.each([
    "",
    "en",
  ])("uses JSON defaults and plural language hints for language %j", async (language) => {
    const config = await store();
    await config.save({
      ...settings,
      provider: "openai",
      model: "gpt-transcribe",
      language,
      apiKey: "synthetic-openai-key",
    });
    const service = new TranscriptionService(
      config,
      fakeFetch((url, init) => {
        expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-openai-key");
        const form = init.body as FormData;
        expect(form.get("model")).toBe("gpt-transcribe");
        expect(form.get("response_format")).toBeNull();
        expect(form.get("language")).toBeNull();
        expect(form.getAll("languages[]")).toEqual(language ? [language] : []);
        return Response.json({ text: "Current model transcript", languages: [{ code: "en" }] });
      })
    );
    expect(await service.transcribe(audio())).toEqual({ text: "Current model transcript" });
  });
});
