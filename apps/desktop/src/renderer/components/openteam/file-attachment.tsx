import { ButtonPrimitive } from "../ui/button-primitive";
import type { AssetRef } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import {
  ATTACHMENT_CODE_PREVIEW_CHAR_LIMIT,
  attachmentTextPreview,
} from "@openteam/product-core/attachments";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { ChevronLeft, ChevronRight, Download, FileText, Maximize2, Music2 } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { authHeaders } from "../../client/auth";
import { api } from "../../client/openteam-api";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import { useVirtualWindow } from "../../hooks/use-virtual-window";
import { type AttachmentPreviewKind, attachmentPreviewKind } from "../../lib/attachment-preview";
import { MessageResponse } from "../ai-elements/message";
import { Button } from "../ui/button";
import { LoadingOrb } from "../ui/loading-orb";
import { AttachmentStage } from "./attachment-stage";
import { ImageAttachmentPreview } from "./image-attachment";
import { FileGlyph, fileGlyphVariant, formatAttachmentSize } from "./attachment-visuals";
import {
  renderSanitizedDocumentProgressively,
  sanitizePreviewDocument,
} from "./document-preview/progressive-dom";
import { parseDocumentPreview } from "./document-preview/worker-client";

export const downloadAttachments = async (attachments: readonly AssetRef[]) => {
  const files = attachments.map((attachment) => ({
    url: api.assetUrl(attachment, true),
    fileName: attachment.fileName,
  }));
  if (window.openteam?.files?.downloadAll) return window.openteam.files.downloadAll(files);
  for (const file of files) {
    const anchor = document.createElement("a");
    const response = await fetch(file.url, { headers: authHeaders(), redirect: "error" });
    if (!response.ok) throw new Error(`File request failed (${response.status})`);
    const objectUrl = URL.createObjectURL(await response.blob());
    anchor.href = objectUrl;
    anchor.download = file.fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
  return { canceled: false, saved: files.length, directory: null };
};

const readBoundedResponse = async (
  response: Response,
  maximumBytes: number,
  truncate: boolean
): Promise<{ buffer: ArrayBuffer; truncated: boolean }> => {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (!truncate && Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("This file is too large to preview here. Download it to open it in full.");
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (!truncate && buffer.byteLength > maximumBytes) {
      throw new Error("This file is too large to preview here. Download it to open it in full.");
    }
    return {
      buffer: buffer.byteLength > maximumBytes ? buffer.slice(0, maximumBytes) : buffer,
      truncated: buffer.byteLength > maximumBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let wasTruncated = false;
  try {
    while (received <= maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maximumBytes - received;
      if (value.byteLength > remaining) {
        if (!truncate) {
          await reader.cancel();
          throw new Error(
            "This file is too large to preview here. Download it to open it in full."
          );
        }
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        received = maximumBytes;
        wasTruncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    buffer: merged.buffer,
    truncated:
      wasTruncated ||
      (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength > received),
  };
};

function PreviewStatus({
  action,
  detail,
  title,
  loading = false,
}: {
  action?: ReactNode;
  detail?: string;
  title: string;
  loading?: boolean;
}) {
  return (
    <div className="grid h-full min-h-[300px] place-items-center px-8 text-center">
      <div>
        {loading ? (
          <LoadingOrb aria-hidden className="mx-auto mb-3" />
        ) : (
          <FileText className="mx-auto mb-3 size-7 text-foreground-tertiary" strokeWidth={1.45} />
        )}
        <div className="text-[13px] font-medium">{title}</div>
        {detail ? (
          <div className="mx-auto mt-1 max-w-[420px] text-[12px] leading-4 text-foreground-secondary">
            {detail}
          </div>
        ) : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

function PdfPage({
  document: pdf,
  pageNumber,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let active = true;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    void pdf
      .getPage(pageNumber)
      .then((page: PDFPageProxy) => {
        if (!active || !canvasRef.current) return;
        const viewport = page.getViewport({ scale: 1.35 });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext("2d");
        if (!context) return;
        const currentTask = page.render({
          canvas,
          canvasContext: context,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          viewport,
        });
        renderTask = currentTask;
        void currentTask.promise.catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [pageNumber, pdf]);

  return (
    <canvas
      className="block max-w-full bg-white shadow-[0_2px_12px_rgba(0,0,0,0.12)]"
      ref={canvasRef}
    />
  );
}

function PdfPreview({ url }: { url: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const estimatePageSize = useCallback(() => 1_120, []);
  const pageKey = useCallback((index: number) => `pdf-page:${index + 1}`, []);
  const { measureElement, totalSize, virtualItems } = useVirtualWindow({
    count: document?.numPages ?? 0,
    estimateSize: estimatePageSize,
    getKey: pageKey,
    initialViewportSize: 720,
    maxItems: 6,
    overscan: 1_120,
    scrollRef,
  });

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | null = null;
    setDocument(null);
    setError(null);
    void Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")])
      .then(async ([pdfjs, worker]) => {
        // An immediate close can happen before either lazy import resolves.
        // Creating a loading task after cleanup would leave its worker unowned.
        if (!active) return;
        const pdfWorkerUrl = worker.default;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const currentTask = pdfjs.getDocument({
          url,
          httpHeaders: authHeaders() as Record<string, string>,
        });
        task = currentTask;
        const loaded = await currentTask.promise;
        if (active) setDocument(loaded);
      })
      .catch((cause) => active && setError(clientErrorMessage(cause, "Preview unavailable")));
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [url]);

  return (
    <div
      aria-label={document ? `${document.numPages} page PDF preview` : "PDF preview"}
      className={
        document && !error
          ? "bot-scrollbar h-full min-h-[360px] overflow-auto bg-[#ececec] dark:bg-[#111]"
          : "h-full"
      }
      ref={scrollRef}
    >
      {/* Keep the scrollport mounted while loading so the virtualizer can bind
          its scroll and resize listeners before the document arrives. */}
      {error ? (
        <PreviewStatus detail={error} title="Couldn’t render this PDF" />
      ) : !document ? (
        <PreviewStatus loading title="Loading PDF…" />
      ) : (
        <div className="relative w-full" style={{ height: totalSize }}>
          {virtualItems.map((item) => (
            <div
              className="absolute inset-x-0 top-0 flex justify-center px-5 py-2"
              key={item.key}
              ref={(node) => measureElement(item.index, item.key, node)}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <PdfPage document={document} pageNumber={item.index + 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressiveHtmlPreview({
  source,
  table = false,
}: {
  source: HTMLElement;
  table?: boolean;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const [completedSource, setCompletedSource] = useState<HTMLElement | null>(null);
  const complete = completedSource === source;

  useLayoutEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    let releaseFrame: number | null = null;
    const stopRendering = renderSanitizedDocumentProgressively(source, article, {
      onComplete: () => {
        setCompletedSource(source);
        // Defer releasing the detached sanitized tree so React Strict Mode can
        // cancel its first effect pass without losing the source document.
        releaseFrame = requestAnimationFrame(() => source.replaceChildren());
      },
    });
    return () => {
      stopRendering();
      if (releaseFrame !== null) cancelAnimationFrame(releaseFrame);
    };
  }, [source]);

  return (
    <article
      aria-busy={complete ? undefined : true}
      className={
        table
          ? "openteam-document-preview openteam-table-preview"
          : "openteam-document-preview mx-auto min-h-full w-full max-w-[860px] bg-white px-12 py-10 text-[#222] shadow-sm"
      }
      ref={articleRef}
    />
  );
}

function LoadedDocumentPreview({
  attachment,
  kind,
  open,
}: {
  attachment: AssetRef;
  kind: AttachmentPreviewKind;
  open: boolean;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "text"; value: string; truncated: boolean }
    | { kind: "html"; value: HTMLElement }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const url = api.assetUrl(attachment);
  const mediaSource = useAuthenticatedResource(
    open && (kind === "audio" || kind === "video") ? url : null
  );

  useEffect(() => {
    if (!open || !["markdown", "text", "json", "table", "docx"].includes(kind)) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    void (async () => {
      const response = await fetch(url, {
        headers: authHeaders(),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error(`File request failed (${response.status})`);
      const maximum = CLIENT_CAPABILITIES.uploads.maxRegularBytes;
      const loaded = await readBoundedResponse(
        response,
        maximum,
        !["docx", "table"].includes(kind)
      );
      const { buffer } = loaded;
      if (kind === "docx" || kind === "table") {
        const html = await parseDocumentPreview(kind, buffer, controller.signal);
        if (controller.signal.aborted) return;
        setState({ kind: "html", value: sanitizePreviewDocument(html) });
        return;
      }
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      const value =
        kind === "json" && decoded.length <= ATTACHMENT_CODE_PREVIEW_CHAR_LIMIT
          ? (() => {
              try {
                return JSON.stringify(JSON.parse(decoded), null, 2);
              } catch {
                return decoded;
              }
            })()
          : decoded;
      if (controller.signal.aborted) return;
      const preview = attachmentTextPreview(value);
      setState({
        kind: "text",
        value: preview.content,
        truncated: loaded.truncated || preview.truncated,
      });
    })().catch((cause) => {
      if (controller.signal.aborted) return;
      setState({ kind: "error", message: clientErrorMessage(cause, "Preview unavailable") });
    });
    return () => controller.abort();
  }, [kind, open, url]);

  if (kind === "pdf") return <PdfPreview url={url} />;
  if (kind === "video") {
    return (
      <div className="grid h-full min-h-[360px] place-items-center bg-black">
        {/* biome-ignore lint/a11y/useMediaCaption: Attachments do not include a separate captions asset. */}
        <video
          className="max-h-full max-w-full"
          controls
          preload="metadata"
          src={mediaSource ?? undefined}
        />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="grid h-full min-h-[320px] place-items-center bg-[#f5f5f5] px-10 dark:bg-[#131313]">
        <div className="w-full max-w-[560px] rounded-[18px] border border-black/[0.07] bg-background p-7 shadow-sm dark:border-white/[0.09]">
          <Music2 className="mx-auto mb-6 size-12 text-foreground-tertiary" strokeWidth={1.25} />
          {/* biome-ignore lint/a11y/useMediaCaption: Attachments do not include a separate captions asset. */}
          <audio className="w-full" controls preload="metadata" src={mediaSource ?? undefined} />
        </div>
      </div>
    );
  }
  if (kind === "unknown") {
    return (
      <PreviewStatus
        action={
          <Button
            onClick={() =>
              void downloadAttachments([attachment]).catch((error) =>
                toast.error(clientErrorMessage(error, "Couldn’t download file"))
              )
            }
            size="sm"
            variant="secondary"
          >
            Download
          </Button>
        }
        detail="This file type can’t be previewed. Download it to open it on your computer."
        title="Preview not available"
      />
    );
  }
  if (state.kind === "idle" || state.kind === "loading")
    return (
      <PreviewStatus loading title={kind === "docx" ? "Loading document…" : "Loading file…"} />
    );
  if (state.kind === "error")
    return <PreviewStatus detail={state.message} title="Couldn’t read file" />;
  if (state.kind === "html") {
    return <ProgressiveHtmlPreview source={state.value} table={kind === "table"} />;
  }
  return (
    <div className="mx-auto min-h-full w-full max-w-[960px] bg-background px-8 py-7">
      {state.truncated ? (
        <div className="mb-4 rounded-[8px] bg-amber-500/10 px-3 py-2 text-[11.5px] text-amber-800 dark:text-amber-200">
          Showing the start of this file
        </div>
      ) : null}
      {kind === "markdown" ? (
        <MessageResponse>{state.value}</MessageResponse>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[18px]">
          {state.value}
        </pre>
      )}
    </div>
  );
}

export function FileAttachmentCard({ attachment }: { attachment: AssetRef }) {
  const [open, setOpen] = useState(false);
  const dot = attachment.fileName.lastIndexOf(".");
  const baseName = dot > 0 ? attachment.fileName.slice(0, dot) : attachment.fileName;
  const extension = dot > 0 ? attachment.fileName.slice(dot) : "";

  return (
    <>
      <article
        className="w-[354px] max-w-full rounded-[22px] bg-white shadow-[0_0_0_0.5px_rgba(28,28,28,0.08),0_1px_4px_0_rgba(28,28,28,0.07),0_6px_12px_0_rgba(28,28,28,0.035)] dark:bg-[#1f1f1f] dark:shadow-[0_0_0_0.5px_#f5f5f51f]"
        data-file-attachment-card=""
      >
        {/* As in the reference, every card opens the viewer; a type it can't show
            offers the download there. */}
        <ButtonPrimitive
          aria-label={`Open ${attachment.fileName}`}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-[22px] p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
          onClick={() => setOpen(true)}
          type="button"
        >
          <FileGlyph variant={fileGlyphVariant(attachment.fileName)} />
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <bdi
              dir="ltr"
              className="flex min-w-0 text-[14px] font-medium leading-5 text-[#1c1c1c] dark:text-[#f5f5f5]"
            >
              <span className="truncate">{baseName}</span>
              <span className="shrink-0">{extension}</span>
            </bdi>
            <span className="truncate text-[13px] leading-[18px] text-[#1c1c1cad] dark:text-[#f5f5f5a8]">
              {formatAttachmentSize(attachment.byteSize)}
            </span>
          </span>
        </ButtonPrimitive>
      </article>

      <FileAttachmentPreview attachment={attachment} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function FileAttachmentPreview({
  attachment,
  open,
  onOpenChange,
}: {
  attachment: AssetRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const kind = attachmentPreviewKind(attachment);
  if (attachment.kind === "image")
    return (
      <ImageAttachmentPreview
        title={attachment.fileName}
        images={[
          {
            url: api.assetUrl(attachment),
            fileName: attachment.fileName,
            alt: attachment.alt || attachment.fileName,
            width: attachment.width,
            height: attachment.height,
          },
        ]}
        activeIndex={open ? 0 : null}
        onActiveIndexChange={(next) =>
          onOpenChange((typeof next === "function" ? next(open ? 0 : null) : next) !== null)
        }
      />
    );
  return (
    <AttachmentStage
      onOpenChange={onOpenChange}
      open={open}
      title={attachment.fileName}
      actions={
        <>
          {(kind === "video" || kind === "pdf") && (
            <ButtonPrimitive
              aria-label={kind === "video" ? "Open video full screen" : "Open preview full screen"}
              className="desktop-elevated-control"
              onClick={() => document.documentElement.requestFullscreen?.()}
              type="button"
            >
              <Maximize2 className="size-4" />
            </ButtonPrimitive>
          )}
          <ButtonPrimitive
            aria-label="Download file"
            className="desktop-elevated-control"
            onClick={() =>
              void downloadAttachments([attachment]).catch((error) =>
                toast.error(clientErrorMessage(error, "Couldn’t download file"))
              )
            }
            type="button"
          >
            <Download className="size-4" strokeWidth={1.8} />
          </ButtonPrimitive>
        </>
      }
    >
      <div className="attachment-stage-document bot-scrollbar file-preview-dialog">
        {kind === "table" && (
          <div className="attachment-table-heading">
            <span>Spreadsheet preview</span>
            <span>Download to view the full workbook</span>
          </div>
        )}
        <LoadedDocumentPreview attachment={attachment} kind={kind} open={open} />
      </div>
    </AttachmentStage>
  );
}

export function MessageFileAttachments({ attachments }: { attachments: readonly AssetRef[] }) {
  return (
    <div className="flex max-w-full flex-col gap-1.5">
      {attachments.map((attachment) => (
        <FileAttachmentCard
          attachment={attachment}
          key={`${attachment.assetId}:${attachment.fileName}`}
        />
      ))}
    </div>
  );
}

export function MediaPositionControl({
  current,
  onNext,
  onPrevious,
  total,
}: {
  current: number;
  onNext: () => void;
  onPrevious: () => void;
  total: number;
}) {
  if (total < 2) return null;
  return (
    <div className="flex items-center gap-1 text-[11px] text-foreground-secondary">
      <ButtonPrimitive
        aria-label="Previous media"
        className="grid size-7 place-items-center"
        onClick={onPrevious}
        type="button"
      >
        <ChevronLeft className="size-4" />
      </ButtonPrimitive>
      <span>
        {current + 1} of {total}
      </span>
      <ButtonPrimitive
        aria-label="Next media"
        className="grid size-7 place-items-center"
        onClick={onNext}
        type="button"
      >
        <ChevronRight className="size-4" />
      </ButtonPrimitive>
    </div>
  );
}
