import { assertBoundedDocumentArchive, assertBoundedDocumentHtml } from "./document-preview-limits";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import type { DocumentPreviewParserKind } from "./document-preview-worker-client";

type DocumentPreviewRequest = {
  buffer: ArrayBuffer;
  kind: DocumentPreviewParserKind;
};

type DocumentPreviewResponse = { html: string; ok: true } | { message: string; ok: false };

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<DocumentPreviewRequest>) => void) | null;
  postMessage(message: DocumentPreviewResponse): void;
};

workerScope.onmessage = (event) => {
  const { buffer, kind } = event.data;
  const parse = Promise.resolve().then(() => {
    assertBoundedDocumentArchive(buffer);
    return kind === "docx"
      ? import("./document-preview-docx-parser").then(({ documentHtml }) => documentHtml(buffer))
      : import("./document-preview-spreadsheet-parser").then(({ spreadsheetHtml }) =>
          spreadsheetHtml(buffer)
        );
  });
  void parse
    .then(assertBoundedDocumentHtml)
    .then((html) => workerScope.postMessage({ html, ok: true }))
    .catch((cause) =>
      workerScope.postMessage({
        message: clientErrorMessage(cause, "Document preview failed"),
        ok: false,
      })
    );
};
