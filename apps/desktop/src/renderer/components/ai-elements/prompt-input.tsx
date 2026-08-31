// Source-owned adaptation of AI Elements prompt-input.tsx.
// https://elements.ai-sdk.dev/components/prompt-input
import type { AssetRef } from "@openbot/contracts";
import { File, ImagePlus, Paperclip, X } from "lucide-react";
import type { ClipboardEvent, DragEvent, FormEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import type { MentionOption } from "../../lib/mentions";
import { ImageAttachment } from "../openbot/image-attachment";
import { MentionEditor } from "../openbot/mention-editor";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const MAX_ATTACHMENTS = 6;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_TEXTAREA_HEIGHT = 120;
const MULTILINE_THRESHOLD = 39;
const SECONDARY_ACTION_CLASS =
  "size-7 rounded-full bg-[#f0f0f0] text-[#696969] shadow-[inset_0_0_0_0.5px_rgba(20,20,20,0.10)] hover:bg-[#e9e9e9] hover:text-[#1f1f1f] disabled:opacity-100 dark:bg-[#3b3b3b] dark:text-[#a8a8a8] dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12)] dark:hover:bg-[#484848] dark:hover:text-[#fafafa]";

function GrokPlusIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 300 300">
      <path d="M150 281Q158 281 163.5 275.5Q169 270 169 263V169H263Q270 169 275.5 163.5Q281 158 281 150Q281 142 275.5 136.5Q270 131 263 131H169V38Q169 30 163.5 24.5Q158 19 150 19Q142 19 136.5 24.5Q131 30 131 37V131H38Q30 131 24.5 136.5Q19 142 19 150Q19 158 24.5 163.5Q30 169 38 169H131V263Q131 270 136.5 275.5Q142 281 150 281Z" />
    </svg>
  );
}

function GrokMicIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 300 300">
      <path
        d="M244 199Q249 199 252 195.5Q255 192 255 188V159Q255 138 247 119Q239 100 224.5 85Q210 70 190 62Q177 56 162 55V19Q162 14 158.5 10.5Q155 7 150 7Q145 7 141.5 10.5Q138 14 138 19V55Q123 56 110 62Q90 70 75.5 85Q61 100 53 119Q45 138 45 159V188Q45 192 48 195.5Q51 199 56 199Q61 199 64.5 195.5Q68 192 68 188V159Q68 143 74 128Q80 113 92 101.5Q104 90 119 83.5Q134 77 150 77Q166 77 181 83.5Q196 90 208 101.5Q220 113 226 128Q232 143 232 159V188Q232 192 235.5 195.5Q239 199 244 199ZM150 293Q170 293 184.5 278.5Q199 264 199 244V159Q199 139 184.5 124.5Q170 110 150 110Q130 110 115.5 124.5Q101 139 101 159V244Q101 264 115.5 278.5Q130 293 150 293Z"
        transform="translate(0 300) scale(1 -1)"
      />
    </svg>
  );
}

function GrokArrowUpIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 300 300">
      <path
        d="M138 277Q144 282 151 281.5Q158 281 163 276L257 182Q262 177 262 169Q262 161 257 155.5Q252 150 244 150Q236 150 230 155L169 217V38Q169 30 163.5 24.5Q158 19 150 19Q142 19 136.5 24.5Q131 30 131 37V217L70 155Q64 150 56 150Q48 150 42.5 155.5Q37 161 37.5 169Q38 177 43 182Z"
        transform="translate(0 300) scale(1 -1)"
      />
    </svg>
  );
}

function GrokReplyIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 300 300">
      <path
        d="M207 271Q211 274 215.5 274Q220 274 224 271L290 205Q293 202 293 197Q293 192 290 189L224 123Q220 120 215.5 120Q211 120 207.5 123Q204 126 204 131Q204 136 207 140L253 185H94Q77 185 62 176.5Q47 168 38.5 153.5Q30 139 30 122Q30 105 38.5 90.5Q47 76 62 67.5Q77 59 94 59H169Q174 59 177 55.5Q180 52 180 47Q180 42 177 38.5Q174 35 169 35H94Q70 35 50 46.5Q30 58 18.5 78Q7 98 7 121.5Q7 145 18.5 165Q30 185 50 197Q70 209 94 209H253L207 254Q204 258 204 262.5Q204 267 207 271Z"
        transform="translate(0 300) scale(1 -1)"
      />
    </svg>
  );
}

function GrokCloseIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 300 300">
      <path
        d="M235 252Q239 255 244 255Q249 255 252 252Q255 249 255 244Q255 239 252 235L167 150L252 65Q255 61 255 56Q255 51 252 48Q249 45 244 45Q239 45 235 48L150 133L65 48Q61 45 56 45Q51 45 48 48Q45 51 45 56Q45 61 48 65L133 150L48 235Q45 239 45 244Q45 249 48 252Q51 255 56 255Q61 255 65 252L150 167Z"
        transform="translate(0 300) scale(1 -1)"
      />
    </svg>
  );
}

interface PendingAsset extends AssetRef {
  id: string;
}

const fileAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") return reject(new Error("read failed"));
      const encoded = reader.result.split(",", 2)[1];
      return encoded ? resolve(encoded) : reject(new Error("read failed"));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("read failed")));
    reader.readAsDataURL(file);
  });

export function PromptInput({
  docked,
  disabled,
  placeholder,
  reply,
  onCancelReply,
  onExpandedChange,
  onAttachmentsChange,
  onUpload,
  assetUrl,
  onSubmit,
  mentionOptions = [],
}: {
  docked?: boolean;
  disabled?: boolean;
  placeholder?: string;
  reply?: { id: string; content: string } | null;
  onCancelReply?: () => void;
  onExpandedChange?: (expanded: boolean) => void;
  onAttachmentsChange?: (count: number) => void;
  onUpload: (input: {
    fileName: string;
    mimeType?: string;
    bytesBase64: string;
  }) => Promise<AssetRef>;
  assetUrl: (asset: Pick<AssetRef, "assetId" | "fileName">) => string;
  mentionOptions?: readonly MentionOption[];
  onSubmit: (
    value: string,
    attachments: AssetRef[],
    options?: { richText?: string }
  ) => Promise<unknown> | undefined;
}) {
  const [value, setValue] = useState("");
  const [richText, setRichText] = useState<string | undefined>();
  const [attachments, setAttachments] = useState<PendingAsset[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retainedReply, setRetainedReply] = useState(reply);
  const [autoExpanded, setAutoExpanded] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState(20);
  const textareaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renderedReply = reply ?? retainedReply;
  const replyOpen = Boolean(reply);
  const hasText = value.trim().length > 0;
  const hasPayload = hasText || attachments.length > 0;
  const expanded = autoExpanded || replyOpen || attachments.length > 0 || Boolean(attachmentError);

  useEffect(() => {
    if (reply) {
      setRetainedReply(reply);
      return;
    }
    if (!retainedReply) return;
    const timer = window.setTimeout(() => setRetainedReply(null), 300);
    return () => window.clearTimeout(timer);
  }, [reply, retainedReply]);

  useEffect(() => {
    if (reply) textareaRef.current?.focus();
  }, [reply]);

  useEffect(() => {
    onAttachmentsChange?.(attachments.length);
  }, [attachments.length, onAttachmentsChange]);

  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const previousHeight = textarea.getBoundingClientRect().height;
    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;
    const nextAutoExpanded =
      value.length > 0 &&
      (value.includes("\n") || scrollHeight >= MULTILINE_THRESHOLD || autoExpanded);
    if (nextAutoExpanded !== autoExpanded) setAutoExpanded(nextAutoExpanded);

    const nextExpanded =
      nextAutoExpanded || replyOpen || attachments.length > 0 || Boolean(attachmentError);
    const minimumHeight = nextExpanded ? 20 : 32;
    const contentHeight = Math.max(
      minimumHeight,
      Math.min(scrollHeight, nextExpanded ? MAX_TEXTAREA_HEIGHT : 32)
    );
    setTextareaHeight(contentHeight);
    textarea.style.overflowY = scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";

    if (previousHeight === contentHeight) {
      textarea.style.height = `${contentHeight}px`;
      return;
    }

    textarea.style.height = `${previousHeight}px`;
    void textarea.offsetHeight;
    textarea.style.height = `${contentHeight}px`;
  }, [attachmentError, attachments.length, autoExpanded, replyOpen, value]);

  const addFiles = useCallback(
    async (files: File[]) => {
      setAttachmentError(null);
      const remaining = MAX_ATTACHMENTS - attachments.length;
      if (remaining <= 0) {
        setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
        return;
      }

      const selected = files.slice(0, remaining);
      const tooLarge = selected.find((file) => {
        const video = file.type.startsWith("video/");
        return file.size > (video ? MAX_VIDEO_BYTES : MAX_FILE_BYTES);
      });
      if (tooLarge) {
        setAttachmentError(
          `${tooLarge.name} is larger than ${tooLarge.type.startsWith("video/") ? 200 : 25} MB.`
        );
        return;
      }
      if (selected.length === 0) {
        setAttachmentError("Choose at least one file.");
        return;
      }
      if (files.length > selected.length) {
        setAttachmentError(`Only the first ${remaining} files were added.`);
      }

      try {
        const loaded: PendingAsset[] = [];
        for (const file of selected) {
          const asset = await onUpload({
            fileName: file.name,
            mimeType: file.type || undefined,
            bytesBase64: await fileAsBase64(file),
          });
          loaded.push({
            ...asset,
            id: `${asset.assetId}:${crypto.randomUUID()}`,
          });
        }
        setAttachments((current) => [...current, ...loaded].slice(0, MAX_ATTACHMENTS));
        textareaRef.current?.focus();
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : "One of the files could not be uploaded."
        );
      }
    },
    [attachments.length, onUpload]
  );

  const blocked = Boolean(disabled || submitting);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = value.trim();
    if ((!content && attachments.length === 0) || blocked) return;
    const pendingAttachments = attachments;
    const pendingRichText = richText;
    setValue("");
    setRichText(undefined);
    setAttachments([]);
    setAttachmentError(null);
    setSubmitting(true);
    try {
      await onSubmit(
        content,
        pendingAttachments.map(({ id: _id, ...asset }) => asset),
        pendingRichText ? { richText: pendingRichText } : undefined
      );
      onCancelReply?.();
    } catch {
      setValue(content);
      setRichText(pendingRichText);
      setAttachments(pendingAttachments);
    } finally {
      setSubmitting(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/")
    );
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragging(false);
    if (blocked) return;
    void addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <form
      className={cn("relative z-[3] w-full px-4 pb-4", docked && "pointer-events-auto")}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!blocked) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onSubmit={submit}
    >
      <input
        aria-label="Choose files"
        className="sr-only"
        disabled={blocked}
        multiple
        onChange={(event) => {
          void addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
      <div className="relative">
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -bottom-4 top-1/2 -z-10 bg-background",
            docked ? "-left-4 right-2" : "-inset-x-4"
          )}
          data-prompt-backdrop
        />
        <div
          className={cn(
            "relative box-border flex min-h-11 flex-col rounded-[22px] border-[0.5px] border-solid border-[#14141426] bg-[#fcfcfc] px-1 py-1 shadow-[0_2px_8px_-1px_#0000000d,0_1px_2px_#00000008,0_0_0_1px_#e4e4e40a] hover:border-[#1414144d] focus-within:border-[#1414144d] dark:border-[#fcfcfc26] dark:bg-[#2f2f2f] dark:hover:border-[#fcfcfc4d] dark:focus-within:border-[#fcfcfc4d]",
            expanded ? "rounded-[18px] px-3 pb-[7px] pt-[9px]" : "rounded-[22px] px-1 py-1",
            "overflow-hidden transition-[border-radius,padding,border-color,background-color,box-shadow,transform] duration-[300ms,300ms,150ms,150ms,150ms,150ms] ease-[cubic-bezier(0.22,1,0.36,1),cubic-bezier(0.22,1,0.36,1),ease,ease,ease,ease] motion-reduce:duration-[120ms,120ms,150ms,150ms,150ms,150ms] motion-reduce:ease-in-out",
            disabled && "opacity-70",
            dragging &&
              "scale-[1.003] shadow-[inset_0_0_0_1.5px_#111,0_8px_24px_rgba(0,0,0,0.13)] dark:shadow-[inset_0_0_0_1.5px_#eee,0_8px_24px_rgba(0,0,0,0.4)]"
          )}
          data-prompt-surface
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-1 z-20 grid place-items-center rounded-[18px] bg-background/90 text-sm font-medium backdrop-blur-sm">
              <span className="flex items-center gap-2">
                <ImagePlus className="size-4" /> Drop files here
              </span>
            </div>
          )}

          <div
            aria-hidden={!replyOpen}
            className={cn(
              "grid w-full transition-[grid-template-rows,margin-bottom,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              replyOpen
                ? "mb-1.5 grid-rows-[1fr] opacity-100"
                : "pointer-events-none mb-0 grid-rows-[0fr] opacity-0"
            )}
          >
            <div className="min-h-0 overflow-hidden">
              {renderedReply && (
                <div
                  className="flex w-full animate-in items-center gap-1.5 rounded-[10px] bg-[#f0f0f0] py-1 pl-2 pr-1 text-[14px] leading-[22px] text-[#747474] fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none dark:bg-[#3b3b3b] dark:text-[rgba(240,240,240,0.74)]"
                  data-reply-preview-id={renderedReply.id}
                >
                  <GrokReplyIcon className="size-3 shrink-0 text-[#777] dark:text-[rgba(240,240,240,0.60)]" />
                  <span className="min-w-0 flex-1 truncate">{renderedReply.content}</span>
                  <button
                    aria-label="Cancel reply"
                    className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[#777] transition-[background-color,color] duration-[120ms] ease-linear hover:bg-[#dcdcdc] hover:text-[#141414] dark:text-[rgba(240,240,240,0.60)] dark:hover:bg-[rgba(240,240,240,0.14)] dark:hover:text-[#f0f0f0]"
                    onClick={onCancelReply}
                    type="button"
                  >
                    <GrokCloseIcon className="size-3" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {attachments.length > 0 && (
            <div className="flex max-w-full gap-2 overflow-x-auto px-1 pb-1 pt-0.5">
              {attachments.map((attachment) =>
                attachment.kind === "image" ? (
                  <ImageAttachment
                    image={{
                      url: assetUrl(attachment),
                      alt: attachment.alt ?? attachment.fileName,
                    }}
                    key={attachment.id}
                    onRemove={() =>
                      setAttachments((current) => current.filter(({ id }) => id !== attachment.id))
                    }
                  />
                ) : (
                  <div
                    className="group/file relative flex h-[72px] w-[220px] shrink-0 items-center gap-2 rounded-[14px] border border-black/10 bg-background px-3 dark:border-white/15"
                    key={attachment.id}
                  >
                    <File className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{attachment.fileName}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {Math.max(1, Math.ceil(attachment.byteSize / 1024))} KB
                      </div>
                    </div>
                    <button
                      aria-label={`Remove ${attachment.fileName}`}
                      className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/85 text-white opacity-0 transition group-hover/file:opacity-100"
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter(({ id }) => id !== attachment.id)
                        )
                      }
                      type="button"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                )
              )}
            </div>
          )}

          {attachmentError && (
            <div aria-live="polite" className="px-2 pb-1 text-[11px] text-destructive">
              {attachmentError}
            </div>
          )}

          <div
            className="relative w-full overflow-visible transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            data-prompt-editor
            style={{ height: expanded ? `${textareaHeight + 38}px` : "34px" }}
          >
            <div
              className={cn("absolute z-10", expanded ? "-left-1 bottom-0" : "bottom-[3px] left-0")}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label="Add attachment"
                    className={cn(SECONDARY_ACTION_CLASS, !expanded && "ml-1")}
                    disabled={blocked}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <GrokPlusIcon className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-[200px] rounded-[12px] border-[#dedede] bg-background p-1.5 text-[13px] leading-[18px] shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
                  side="top"
                  sideOffset={8}
                >
                  <DropdownMenuItem
                    className="h-[30px] gap-1 rounded-[6px] px-2 py-1.5 text-[13px] leading-[18px]"
                    onSelect={() => fileInputRef.current?.click()}
                  >
                    <span className="grid size-[18px] shrink-0 place-items-center">
                      <Paperclip className="size-3.5" />
                    </span>
                    Attach files
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <MentionEditor
              className={cn(
                "max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-[14px] leading-5 outline-none transition-[height] duration-150 ease-out placeholder:text-[#b7b7b7] motion-reduce:transition-none dark:placeholder:text-[#6d6d6d]",
                "absolute left-0 w-full",
                expanded
                  ? "top-0 min-h-5 px-0 py-0"
                  : hasPayload
                    ? "top-px pb-1.5 pl-10 pr-[76px] pt-1.5"
                    : "top-px px-10 py-1.5"
              )}
              disabled={Boolean(disabled)}
              editorRef={textareaRef}
              onChange={(plainText, nextRichText) => {
                setValue(plainText);
                setRichText(nextRichText);
              }}
              onPaste={onPaste}
              onSubmit={() => void submit()}
              options={mentionOptions}
              placeholder={
                attachments.length > 0
                  ? "Add a message, or hit send."
                  : reply
                    ? "Reply…"
                    : placeholder
              }
              value={value}
              onHeightChange={() => {
                const editor = textareaRef.current;
                if (!editor) return;
                const scrollHeight = editor.scrollHeight;
                setTextareaHeight(
                  Math.max(20, Math.min(scrollHeight, expanded ? MAX_TEXTAREA_HEIGHT : 32))
                );
              }}
            />
            <div
              className={cn(
                "absolute z-10 flex items-center gap-2",
                expanded ? "-right-1 bottom-0" : "bottom-[3px] right-1"
              )}
            >
              {hasPayload && (
                <Button
                  aria-label="Voice input unavailable"
                  className={SECONDARY_ACTION_CLASS}
                  disabled
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <GrokMicIcon className="size-4 animate-in fade-in-0 zoom-in-50 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none" />
                </Button>
              )}
              <Button
                aria-label={hasPayload ? "Send message" : "Voice input unavailable"}
                className="relative size-7 rounded-full bg-[#070707] text-[#fcfcfc] shadow-none transition-opacity hover:bg-[#070707] hover:opacity-90 disabled:bg-[#070707] disabled:opacity-40 dark:bg-[#fafafa] dark:text-[#141414] dark:hover:bg-[#fafafa]"
                disabled={blocked}
                size="icon"
                type="submit"
              >
                <GrokMicIcon
                  className={cn(
                    "absolute size-4 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    hasPayload ? "scale-50 opacity-0" : "scale-100 opacity-100"
                  )}
                />
                <GrokArrowUpIcon
                  className={cn(
                    "absolute size-4 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    hasPayload ? "scale-100 opacity-100" : "scale-50 opacity-0"
                  )}
                />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
