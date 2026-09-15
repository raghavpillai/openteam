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
    expect(JSON.stringify(view)).not.toContain("test-private-key");
    expect(await readFile(config.path, "utf8")).not.toContain("test-private-key");
    expect((await stat(config.path)).mode & 0o777).toBe(0o600);
    expect(
      (await new TranscriptionStore(config.path, () => "a".repeat(40)).credentials()).apiKey
    ).toBe("test-private-key");
    await config.save({ ...settings, model: "another" });
    expect((await config.credentials()).apiKey).toBe("test-private-key");
    await config.save({ ...settings, baseUrl: "http://different.test/v1" });
    expect((await config.credentials()).apiKey).toBeNull();
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
  test("cancelling a stalled upload releases its stream before calling the provider", async () => {
    const config = await store();
    await config.save(settings);
    let cancelled = false;
    const service = new TranscriptionService(
      config,
      fakeFetch(() => {
        throw new Error("Provider must not be called");
      })
    );
    const controller = new AbortController();
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const pending = service.transcribe(
      new Request("http://local", {
        method: "POST",
        body: stream,
        headers: { "content-type": "audio/wav" },
        signal: controller.signal,
      })
    );
    await Bun.sleep(10);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "transcription_cancelled" });
    expect(cancelled).toBe(true);
  });
  test("forwards a multipart recording with server credentials and normalizes the transcript", async () => {
    const config = await store();
    await config.save({ ...settings, apiKey: "private" });
    const service = new TranscriptionService(
      config,
      fakeFetch(async (url, init) => {
        expect(url).toBe("http://audio.test:8000/v1/audio/transcriptions");
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer private");
        const form = init.body as FormData;
        expect(form.get("model")).toBe("parakeet");
        expect(form.get("language")).toBe("en");
        expect(form.get("response_format")).toBe("json");
        expect((form.get("file") as File).type).toBe("audio/wav");
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
      message: "The transcription provider rejected the API key. Check Server settings.",
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
  test("cancelling propagates upstream and releases concurrency capacity", async () => {
    const config = await store();
    await config.save(settings);
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = new TranscriptionService(
      config,
      fakeFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
              once: true,
            });
            entered();
          })
      )
    );
    const running = service.transcribe(audio(controller.signal));
    await ready;
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "transcription_cancelled" });
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
  test("OpenAI's mixed catalog shows only transcription models", async () => {
    const config = await store();
    const service = new TranscriptionService(
      config,
      fakeFetch(() =>
        Response.json({
          data: [
            { id: "gpt-5" },
            { id: "gpt-4o-transcribe" },
            { id: "whisper-1" },
            { id: "text-embedding-3-small" },
            { id: "gpt-4o-mini-tts" },
            { id: "gpt-realtime" },
            { id: "opaque", task: "transcription" },
            { id: "opaque-chat", task: "chat" },
          ],
        })
      )
    );
    expect(
      await service.models({
        ...settings,
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "synthetic-key",
      })
    ).toEqual({ models: ["gpt-4o-transcribe", "opaque", "whisper-1"] });
  });
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
  test("requires a key for OpenAI discovery and rejects embedded credentials", async () => {
    const config = await store();
    await expect(config.discoveryCredentials({ ...settings, provider: "openai" })).rejects.toThrow(
      "API key"
    );
    await expect(
      config.discoveryCredentials({ ...settings, baseUrl: "https://user:secret@audio.test/v1" })
    ).rejects.toThrow();
  });
  test.each([
    404, 405,
  ])("HTTP %i offers manual model entry without echoing provider bodies", async (status) => {
    const config = await store();
    const service = new TranscriptionService(
      config,
      fakeFetch(() => new Response("sensitive upstream body", { status }))
    );
    await expect(service.models(settings)).rejects.toMatchObject({
      code: "model_discovery_unavailable",
      message:
        "This provider does not offer model discovery. Enter its transcription model ID manually.",
    });
  });
  test.each([
    401, 429, 500,
  ])("HTTP %i is a recoverable, redacted discovery failure", async (status) => {
    const config = await store();
    const service = new TranscriptionService(
      config,
      fakeFetch(() => new Response("synthetic-secret", { status }))
    );
    try {
      await service.models(settings);
      throw new Error("Unexpected success");
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-secret");
      expect(error).toMatchObject({ code: "transcription_provider_error" });
    }
  });
  test.each([
    null,
    {},
    { data: [{ id: 42 }] },
    { data: [{ id: "bad\u001b[31m" }] },
    { data: [{ id: "x".repeat(257) }] },
  ])("rejects malformed catalog %j", async (body) => {
    const config = await store();
    const service = new TranscriptionService(
      config,
      fakeFetch(() => Response.json(body))
    );
    await expect(service.models(settings)).rejects.toMatchObject({
      code: "model_discovery_failed",
    });
  });
  test("bounds discovery responses and redacts transport errors", async () => {
    const config = await store();
    for (const fetcher of [
      fakeFetch(() => new Response("x".repeat(1024 * 1024 + 1))),
      fakeFetch(() => {
        throw new Error("synthetic-private-key");
      }),
    ]) {
      const service = new TranscriptionService(config, fetcher);
      await expect(service.models(settings)).rejects.toMatchObject({
        code: "model_discovery_failed",
        message:
          "Could not load transcription models. Check the base URL, credentials and connection, or enter a model ID manually.",
      });
    }
  });
});
