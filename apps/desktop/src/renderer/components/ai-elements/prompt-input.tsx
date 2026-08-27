// Source-owned adaptation of AI Elements prompt-input.tsx.
// https://elements.ai-sdk.dev/components/prompt-input
import type { InlineImageInput } from "@openbot/contracts";
import { ImagePlus, Paperclip, Plus, Square } from "lucide-react";
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { ImageAttachment } from "../openbot/image-attachment";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const MAX_TEXTAREA_HEIGHT = 120;
const MULTILINE_THRESHOLD = 39;
const SECONDARY_ACTION_CLASS =
  "size-7 rounded-full bg-[#f2f2f2] text-[#737373] shadow-[inset_0_0_0_0.5px_rgba(20,20,20,0.10)] hover:bg-[#ebebeb] hover:text-[#1f1f1f] disabled:opacity-100 dark:bg-[#3c3c3c] dark:text-[#a8a8a8] dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12)] dark:hover:bg-[#484848] dark:hover:text-[#fafafa]";

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

interface PendingImage extends InlineImageInput {
  id: string;
}

const fileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("read failed"))
    );
    reader.addEventListener("error", () => reject(reader.error ?? new Error("read failed")));
    reader.readAsDataURL(file);
  });

export function PromptInput({
  disabled,
  running,
  placeholder,
  reply,
  onCancelReply,
  onExpandedChange,
  onImagesChange,
  onSubmit,
  onStop,
}: {
  disabled?: boolean;
  running?: boolean;
  placeholder?: string;
  reply?: { id: string; content: string } | null;
  onCancelReply?: () => void;
  onExpandedChange?: (expanded: boolean) => void;
  onImagesChange?: (count: number) => void;
  onSubmit: (value: string, images: InlineImageInput[]) => Promise<unknown> | undefined;
  onStop?: () => Promise<unknown> | undefined;
}) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retainedReply, setRetainedReply] = useState(reply);
  const [autoExpanded, setAutoExpanded] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState(20);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renderedReply = reply ?? retainedReply;
  const replyOpen = Boolean(reply);
  const hasText = value.trim().length > 0;
  const hasPayload = hasText || images.length > 0;
  const expanded = autoExpanded || replyOpen || images.length > 0 || Boolean(attachmentError);

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
    onImagesChange?.(images.length);
  }, [images.length, onImagesChange]);

  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.value !== value) return;

    const previousHeight = textarea.getBoundingClientRect().height;
    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;
    const nextAutoExpanded =
      value.length > 0 &&
      (value.includes("\n") || scrollHeight >= MULTILINE_THRESHOLD || autoExpanded);
    if (nextAutoExpanded !== autoExpanded) setAutoExpanded(nextAutoExpanded);

    const nextExpanded =
      nextAutoExpanded || replyOpen || images.length > 0 || Boolean(attachmentError);
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
  }, [attachmentError, autoExpanded, images.length, replyOpen, value]);

  const addFiles = useCallback(
    async (files: File[]) => {
      setAttachmentError(null);
      const remaining = MAX_IMAGES - images.length;
      if (remaining <= 0) {
        setAttachmentError(`You can attach up to ${MAX_IMAGES} images.`);
        return;
      }

      const selected = files.filter((file) => IMAGE_TYPES.has(file.type)).slice(0, remaining);
      const tooLarge = selected.find((file) => file.size > MAX_IMAGE_BYTES);
      if (tooLarge) {
        setAttachmentError(`${tooLarge.name} is larger than 20 MB.`);
        return;
      }
      if (selected.length === 0) {
        setAttachmentError("Choose PNG, JPEG, WebP, or GIF images.");
        return;
      }
      if (files.length > selected.length) {
        setAttachmentError(
          files.some((file) => !IMAGE_TYPES.has(file.type))
            ? "Only PNG, JPEG, WebP, and GIF images were added."
            : `Only the first ${remaining} images were added.`
        );
      }

      try {
        const loaded = await Promise.all(
          selected.map(async (file) => ({
            id: crypto.randomUUID(),
            url: await fileAsDataUrl(file),
            alt: file.name,
          }))
        );
        setImages((current) => [...current, ...loaded].slice(0, MAX_IMAGES));
        textareaRef.current?.focus();
      } catch {
        setAttachmentError("One of the images could not be read.");
      }
    },
    [images.length]
  );

  const blocked = Boolean(disabled || running || submitting);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = value.trim();
    if ((!content && images.length === 0) || blocked) return;
    const pendingImages = images;
    setValue("");
    setImages([]);
    setAttachmentError(null);
    setSubmitting(true);
    try {
      await onSubmit(
        content,
        pendingImages.map(({ url, alt }) => ({ url, alt }))
      );
      onCancelReply?.();
    } catch {
      setValue(content);
      setImages(pendingImages);
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
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
      className="relative z-[3] w-full px-4 pb-4"
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
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label="Choose images"
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
          className="pointer-events-none absolute -inset-x-4 -bottom-4 top-1/2 -z-10 bg-background"
          data-prompt-backdrop
        />
        <div
          className={cn(
            "relative box-border flex min-h-11 flex-col rounded-[22px] border-[0.5px] border-solid border-[#14141426] bg-[#fcfcfc] px-1 py-1 shadow-[0_2px_8px_-1px_#0000000d,0_1px_2px_#00000008,0_0_0_1px_#e4e4e40a] hover:border-[#1414144d] focus-within:border-[#1414144d] dark:border-[#ffffff26] dark:bg-[#2f2f2f] dark:hover:border-[#ffffff4d] dark:focus-within:border-[#ffffff4d]",
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
                <ImagePlus className="size-4" /> Drop images here
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
                  className="flex w-full animate-in items-center gap-1.5 rounded-[10px] bg-[#f0f0f0] py-1 pl-2 pr-1 text-[14px] leading-[22px] text-[#747474] fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none dark:bg-[#292929] dark:text-[#aaa]"
                  data-reply-preview-id={renderedReply.id}
                >
                  <GrokReplyIcon className="size-3 shrink-0 text-[#777] dark:text-[#999]" />
                  <span className="min-w-0 flex-1 truncate">{renderedReply.content}</span>
                  <button
                    aria-label="Cancel reply"
                    className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[#777] transition-[background-color,color] duration-[120ms] ease-linear hover:bg-[#dcdcdc] hover:text-[#141414] dark:text-[#999] dark:hover:bg-[#404040] dark:hover:text-[#f0f0f0]"
                    onClick={onCancelReply}
                    type="button"
                  >
                    <GrokCloseIcon className="size-3" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {images.length > 0 && (
            <div className="flex max-w-full gap-2 overflow-x-auto px-1 pb-1 pt-0.5">
              {images.map((image) => (
                <ImageAttachment
                  image={image}
                  key={image.id}
                  onRemove={() =>
                    setImages((current) => current.filter(({ id }) => id !== image.id))
                  }
                />
              ))}
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
                    <Plus className="size-4" />
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
            <textarea
              aria-label="Message"
              className={cn(
                "max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-[14px] leading-5 outline-none transition-[height] duration-150 ease-out placeholder:text-[#b7b7b7] motion-reduce:transition-none dark:placeholder:text-[#6d6d6d]",
                "absolute left-0 w-full",
                expanded
                  ? "top-0 min-h-5 px-0 py-0"
                  : hasPayload
                    ? "top-px pb-1.5 pl-10 pr-[76px] pt-1.5"
                    : "top-px px-10 py-1.5"
              )}
              disabled={blocked}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={
                images.length > 0 ? "Add a message, or hit send." : reply ? "Reply…" : placeholder
              }
              ref={textareaRef}
              rows={1}
              spellCheck={false}
              value={value}
            />
            <div
              className={cn(
                "absolute z-10 flex items-center gap-2",
                expanded ? "-right-1 bottom-0" : "bottom-[3px] right-1"
              )}
            >
              {running ? (
                <Button
                  aria-label="Stop run"
                  className="size-7 rounded-full bg-[#070707] hover:bg-[#070707]"
                  onClick={() => void onStop?.()}
                  size="icon"
                  type="button"
                >
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
