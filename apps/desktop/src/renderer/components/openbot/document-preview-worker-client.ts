export type DocumentPreviewParserKind = "docx" | "table";

type DocumentPreviewRequest = {
  buffer: ArrayBuffer;
  kind: DocumentPreviewParserKind;
};

type DocumentPreviewResponse = { html: string; ok: true } | { message: string; ok: false };

export interface DocumentPreviewWorker {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<DocumentPreviewResponse>) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: DocumentPreviewRequest, transfer: Transferable[]): void;
  terminate(): void;
}

type WorkerFactory = () => DocumentPreviewWorker;

const createWorker: WorkerFactory = () =>
  new Worker(new URL("./document-preview.worker.ts", import.meta.url), {
    name: "openbot-document-preview",
    type: "module",
  });

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/**
 * Runs expensive document parsing away from the renderer thread. Each request
 * owns a worker so closing the preview can synchronously cancel parsing and
 * release the parser module without retaining a large shared worker heap.
 */
export const parseDocumentPreview = (
  kind: DocumentPreviewParserKind,
  buffer: ArrayBuffer,
  signal: AbortSignal,
  workerFactory: WorkerFactory = createWorker
): Promise<string> => {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const worker = workerFactory();
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => settle(() => reject(abortError()));

    worker.onmessage = (event) => {
      const response = event.data;
      if (response.ok) settle(() => resolve(response.html));
      else settle(() => reject(new Error(response.message)));
    };
    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || "Document preview worker failed.")));
    };
    worker.onmessageerror = () => {
      settle(() => reject(new Error("Document preview worker returned an unreadable response.")));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      worker.postMessage({ buffer, kind }, [buffer]);
    } catch (cause) {
      settle(() => reject(cause));
    }
  });
};
