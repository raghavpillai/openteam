import { describe, expect, test } from "bun:test";
import {
  type DocumentPreviewWorker,
  parseDocumentPreview,
} from "../../src/renderer/components/openteam/document-preview/worker-client";

class MockWorker implements DocumentPreviewWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage:
    | ((event: MessageEvent<{ html: string; ok: true } | { message: string; ok: false }>) => void)
    | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: { message: unknown; transfer: Transferable[] } | null = null;
  terminated = 0;

  postMessage(message: unknown, transfer: Transferable[]) {
    this.posted = { message, transfer };
  }

  terminate() {
    this.terminated += 1;
  }
}

describe("document preview worker client", () => {
  test("transfers the file buffer and releases the one-shot worker after success", async () => {
    const worker = new MockWorker();
    const controller = new AbortController();
    const buffer = new ArrayBuffer(32);
    const result = parseDocumentPreview("docx", buffer, controller.signal, () => worker);

    expect(worker.posted?.message).toEqual({ buffer, kind: "docx" });
    expect(worker.posted?.transfer).toEqual([buffer]);
    worker.onmessage?.(
      new MessageEvent("message", { data: { html: "<p>Document</p>", ok: true } })
    );

    expect(await result).toBe("<p>Document</p>");
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
  });

  test("terminates parsing immediately when the preview closes", async () => {
    const worker = new MockWorker();
    const controller = new AbortController();
    const result = parseDocumentPreview(
      "table",
      new ArrayBuffer(16),
      controller.signal,
      () => worker
    );

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage).toBeNull();
  });

  test("does not initialize a worker for an already-cancelled preview", async () => {
    const controller = new AbortController();
    controller.abort();
    let created = 0;

    const result = parseDocumentPreview("docx", new ArrayBuffer(1), controller.signal, () => {
      created += 1;
      return new MockWorker();
    });

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(created).toBe(0);
  });

  test("surfaces worker parse failures and still releases the worker", async () => {
    const worker = new MockWorker();
    const result = parseDocumentPreview(
      "table",
      new ArrayBuffer(8),
      new AbortController().signal,
      () => worker
    );

    worker.onmessage?.(
      new MessageEvent("message", { data: { message: "This spreadsheet is empty.", ok: false } })
    );

    await expect(result).rejects.toThrow("This spreadsheet is empty.");
    expect(worker.terminated).toBe(1);
  });
});
