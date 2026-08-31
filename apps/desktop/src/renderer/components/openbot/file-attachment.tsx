import type { AssetRef } from "@openbot/contracts";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FileJson,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  Maximize2,
  Music2,
  Video,
  X,
} from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { api } from "../../client/openbot-api";
import {
  type AttachmentPreviewKind,
  attachmentPreviewKind,
  formatAttachmentBytes,
} from "../../lib/attachment-preview";
import { cn } from "../../lib/cn";
import { MessageResponse } from "../ai-elements/message";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

export const downloadAttachments = async (attachments: readonly AssetRef[]) => {
  const files = attachments.map((attachment) => ({
    url: api.assetUrl(attachment, true),
    fileName: attachment.fileName,
  }));
  if (window.openbot?.files?.downloadAll) return window.openbot.files.downloadAll(files);
  for (const file of files) {
    const anchor = document.createElement("a");
    anchor.href = file.url;
    anchor.download = file.fileName;
    anchor.click();
  }
  return { canceled: false, saved: files.length, directory: null };
};

const iconForKind = (kind: AttachmentPreviewKind) => {
  if (kind === "video") return Video;
  if (kind === "audio") return Music2;
  if (kind === "json") return FileJson;
  if (kind === "table") return FileSpreadsheet;
  if (kind === "pdf" || kind === "docx" || kind === "markdown" || kind === "text") return FileText;
  return File;
};

const previewable = (kind: AttachmentPreviewKind) => kind !== "unknown";

const splitFileName = (fileName: string) => {
  const dot = fileName.lastIndexOf(".");
  return dot > 0
    ? { base: fileName.slice(0, dot), extension: fileName.slice(dot) }
    : { base: fileName, extension: "" };
};

const sanitizePreviewHtml = (value: string) => {
  const document = new DOMParser().parseFromString(value, "text/html");
  for (const element of document.querySelectorAll(
    "script,style,iframe,object,embed,form,input,button,textarea,select,link,meta"
  )) {
    element.remove();
  }
  for (const element of document.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") element.removeAttribute(attribute.name);
      if (
        ["href", "src"].includes(name) &&
        !/^(?:https?:|data:image\/|#|\/)/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return document.body.innerHTML;
};

function PreviewStatus({
  detail,
  title,
  loading = false,
}: {
  detail?: string;
  title: string;
  loading?: boolean;
}) {
  return (
    <div className="grid h-full min-h-[300px] place-items-center px-8 text-center">
      <div>
        {loading ? (
          <LoaderCircle className="mx-auto mb-3 size-5 animate-spin text-foreground-tertiary" />
        ) : (
          <FileText className="mx-auto mb-3 size-7 text-foreground-tertiary" strokeWidth={1.45} />
        )}
        <div className="text-[13px] font-medium">{title}</div>
        {detail ? (
          <div className="mx-auto mt-1 max-w-[420px] text-[12px] leading-4 text-foreground-secondary">
            {detail}
          </div>
        ) : null}
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
    void pdf.getPage(pageNumber).then((page: PDFPageProxy) => {
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
    });
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

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | null = null;
    void import("pdfjs-dist")
      .then(async (pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const currentTask = pdfjs.getDocument({ url });
        task = currentTask;
        const loaded = await currentTask.promise;
        if (active) setDocument(loaded);
      })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [url]);

  if (error) return <PreviewStatus detail={error} title="Couldn’t render this PDF" />;
  if (!document) return <PreviewStatus loading title="Loading PDF…" />;
  return (
    <div className="flex min-h-full flex-col items-center gap-4 bg-[#ececec] p-5 dark:bg-[#111]">
      {Array.from({ length: document.numPages }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: PDF page numbers are stable document identities.
        <PdfPage document={document} key={index + 1} pageNumber={index + 1} />
      ))}
    </div>
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
    | { kind: "html"; value: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const url = api.assetUrl(attachment);

  useEffect(() => {
    if (!open || !["markdown", "text", "json", "table", "docx"].includes(kind)) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    void (async () => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`File request failed (${response.status})`);
      const buffer = await response.arrayBuffer();
      if (kind === "docx") {
        if (buffer.byteLength > 16 * 1024 * 1024) {
          throw new Error(
            "This document is too large to preview here. Download it to open in Word."
          );
        }
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buffer },
          { convertImage: mammoth.images.dataUri }
        );
        setState({ kind: "html", value: sanitizePreviewHtml(result.value) });
        return;
      }
      if (kind === "table") {
        if (buffer.byteLength > 12 * 1024 * 1024) {
          throw new Error(
            "This spreadsheet is too large to preview here. Download it to open it in full."
          );
        }
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(buffer, { type: "array" });
        const first = workbook.SheetNames[0];
        if (!first) throw new Error("This spreadsheet is empty.");
        const sheet = workbook.Sheets[first];
        if (!sheet) throw new Error("This spreadsheet is empty.");
        const html = XLSX.utils.sheet_to_html(sheet);
        setState({ kind: "html", value: sanitizePreviewHtml(html) });
        return;
      }
      const maximum = 1024 * 1024;
      const bytes = buffer.byteLength > maximum ? buffer.slice(0, maximum) : buffer;
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const value =
        kind === "json"
          ? (() => {
              try {
                return JSON.stringify(JSON.parse(decoded), null, 2);
              } catch {
                return decoded;
              }
            })()
          : decoded;
      setState({ kind: "text", value, truncated: buffer.byteLength > maximum });
    })().catch((cause) => {
      if (controller.signal.aborted) return;
      setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => controller.abort();
  }, [kind, open, url]);

  if (kind === "pdf") return <PdfPreview url={url} />;
  if (kind === "video") {
    return (
      <div className="grid h-full min-h-[360px] place-items-center bg-black">
        {/* biome-ignore lint/a11y/useMediaCaption: Attachments do not include a separate captions asset. */}
        <video className="max-h-full max-w-full" controls preload="metadata" src={url} />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="grid h-full min-h-[320px] place-items-center bg-[#f5f5f5] px-10 dark:bg-[#131313]">
        <div className="w-full max-w-[560px] rounded-[18px] border border-black/[0.07] bg-background p-7 shadow-sm dark:border-white/[0.09]">
          <Music2 className="mx-auto mb-6 size-12 text-foreground-tertiary" strokeWidth={1.25} />
          {/* biome-ignore lint/a11y/useMediaCaption: Attachments do not include a separate captions asset. */}
          <audio className="w-full" controls preload="metadata" src={url} />
        </div>
      </div>
    );
  }
  if (kind === "unknown") {
    return (
      <PreviewStatus
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
    return (
      <article
        className="openbot-document-preview mx-auto min-h-full w-full max-w-[860px] bg-white px-12 py-10 text-[#222] shadow-sm"
        // Content is generated locally, then stripped of active/embedded elements and event handlers.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitizePreviewHtml removes executable markup first.
        dangerouslySetInnerHTML={{ __html: state.value }}
      />
    );
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
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px]">
          {state.value}
        </pre>
      )}
    </div>
  );
}

export function FileAttachmentCard({ attachment }: { attachment: AssetRef }) {
  const [open, setOpen] = useState(false);
  const kind = attachmentPreviewKind(attachment);
  const Icon = iconForKind(kind);
  const name = splitFileName(attachment.fileName);
  const canPreview = previewable(kind);

  return (
    <>
      <article className="group/file my-1 flex w-fit min-w-[min(220px,100%)] max-w-[min(340px,100%)] items-center gap-2 rounded-[12px] border-[0.5px] border-black/[0.075] bg-background px-2 py-2 text-left shadow-[0_1px_2px_rgba(0,0,0,0.02)] dark:border-white/[0.1] dark:bg-[#181818]">
        <button
          aria-label={canPreview ? `Open ${attachment.fileName}` : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-[8px] text-left outline-none",
            canPreview && "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/35"
          )}
          disabled={!canPreview}
          onClick={() => canPreview && setOpen(true)}
          type="button"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-black/[0.045] dark:bg-white/[0.07]">
            <Icon className="size-[17px] text-foreground-secondary" strokeWidth={1.65} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-[17px]">
              {name.base}
              <span className="text-foreground-tertiary">{name.extension}</span>
            </span>
            <span className="mt-px block text-[10.5px] leading-4 text-foreground-tertiary">
              {formatAttachmentBytes(attachment.byteSize)}
            </span>
          </span>
        </button>
        <a
          aria-label={`Download ${attachment.fileName}`}
          className="grid size-8 shrink-0 place-items-center rounded-[8px] text-foreground-tertiary opacity-75 outline-none transition hover:bg-black/[0.045] hover:text-foreground group-hover/file:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/35 dark:hover:bg-white/[0.07]"
          download={attachment.fileName}
          href={api.assetUrl(attachment, true)}
        >
          <Download className="size-4" strokeWidth={1.75} />
        </a>
      </article>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent
          className="grid h-[calc(100vh-80px)] w-[min(1100px,calc(100vw-80px))] max-w-none grid-rows-[40px_minmax(0,1fr)] gap-0 overflow-hidden rounded-[12px] border-[0.5px] border-black/10 bg-[#fcfcfc] p-0 shadow-[0_32px_80px_rgba(0,0,0,0.55)] dark:border-[#303030] dark:bg-[#070707]"
          onOpenAutoFocus={(event) => event.preventDefault()}
          showCloseButton={false}
          surface="transparent"
        >
          <DialogTitle className="sr-only">{attachment.fileName}</DialogTitle>
          <DialogDescription className="sr-only">
            Preview and download {attachment.fileName}
          </DialogDescription>
          <header className="flex min-w-0 items-center gap-3 border-b-[0.5px] border-black/[0.07] bg-[#f7f7f7] px-4 dark:border-white/[0.08] dark:bg-[#111111]">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
              {attachment.fileName}
            </span>
            <a
              aria-label="Download file"
              className="grid size-8 place-items-center rounded-full text-foreground-secondary hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              download={attachment.fileName}
              href={api.assetUrl(attachment, true)}
            >
              <Download className="size-4" />
            </a>
            {(kind === "video" || kind === "pdf") && (
              <button
                aria-label={
                  kind === "video" ? "Open video full screen" : "Open preview full screen"
                }
                className="grid size-8 place-items-center rounded-full text-foreground-secondary hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                onClick={() => document.documentElement.requestFullscreen?.()}
                type="button"
              >
                <Maximize2 className="size-4" />
              </button>
            )}
            <button
              aria-label="Close preview"
              className="grid size-8 place-items-center rounded-full text-foreground-secondary hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              onClick={() => setOpen(false)}
              type="button"
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="grok-scrollbar min-h-0 overflow-auto bg-[#fcfcfc] dark:bg-[#070707]">
            <LoadedDocumentPreview attachment={attachment} kind={kind} open={open} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function MessageFileAttachments({ attachments }: { attachments: readonly AssetRef[] }) {
  return (
    <div className="flex flex-col gap-1.5">
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
      <button
        aria-label="Previous media"
        className="grid size-7 place-items-center"
        onClick={onPrevious}
        type="button"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span>
        {current + 1} of {total}
      </span>
      <button
        aria-label="Next media"
        className="grid size-7 place-items-center"
        onClick={onNext}
        type="button"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
