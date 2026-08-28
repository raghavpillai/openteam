import type {
  ClipboardEvent,
  KeyboardEvent,
  MutableRefObject,
} from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import {
  mentionPlainText,
  mentionRichText,
  moveMentionSelection,
  shouldRefreshMentionPickerOnKeyUp,
  type MentionOption,
  type MentionSegment,
} from "../../lib/mentions";
import { BotAvatar } from "./avatar";

const serializeNode = (node: Node, output: MentionSegment[]) => {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.textContent) output.push({ type: "text", text: node.textContent });
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (node.dataset.mentionId) {
    output.push({
      type: "mention",
      id: node.dataset.mentionId,
      label: node.dataset.mentionLabel ?? node.textContent?.replace(/^@/, "") ?? "",
      handle: node.dataset.mentionHandle ?? "",
    });
    return;
  }
  if (node.tagName === "BR") {
    output.push({ type: "text", text: "\n" });
    return;
  }
  const block = node !== node.parentElement && ["DIV", "P"].includes(node.tagName);
  const before = output.length;
  for (const child of node.childNodes) serializeNode(child, output);
  if (block && output.length > before) output.push({ type: "text", text: "\n" });
};

const editorSegments = (editor: HTMLDivElement): MentionSegment[] => {
  const output: MentionSegment[] = [];
  for (const child of editor.childNodes) serializeNode(child, output);
  const final = output.at(-1);
  if (final?.type === "text" && final.text.endsWith("\n")) {
    final.text = final.text.slice(0, -1);
    if (!final.text) output.pop();
  }
  return output;
};

const currentMentionQuery = (editor: HTMLDivElement) => {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const prefix = range.startContainer.textContent?.slice(0, range.startOffset) ?? "";
  const match = prefix.match(/(?:^|\s)@([\p{L}\p{N}._-]*)$/u);
  if (!match) return null;
  return {
    query: (match[1] ?? "").toLocaleLowerCase("en-US"),
    startOffset: range.startOffset - (match[1]?.length ?? 0) - 1,
    range: range.cloneRange(),
  };
};

export function MentionEditor({
  className,
  disabled,
  editorRef,
  options,
  placeholder,
  value,
  onChange,
  onHeightChange,
  onPaste,
  onSubmit,
}: {
  className?: string;
  disabled?: boolean;
  editorRef: MutableRefObject<HTMLDivElement | null>;
  options: readonly MentionOption[];
  placeholder?: string;
  value: string;
  onChange: (plainText: string, richText: string | undefined) => void;
  onHeightChange?: (height: number) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onSubmit: () => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickerPosition, setPickerPosition] = useState({ left: 8, top: 8 });
  const mentionRange = useRef<Range | null>(null);
  const queryRef = useRef<string | null>(null);
  const optionAvatarById = useRef(new Map<string, HTMLElement>());
  const listboxId = useId();

  const filtered = useMemo(() => {
    if (query === null) return [];
    return options.filter(
      (option) =>
        option.label.toLocaleLowerCase("en-US").includes(query) || option.handle.includes(query)
    );
  }, [options, query]);

  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const segments = editorSegments(editor);
    const hasMention = segments.some((segment) => segment.type === "mention");
    onChange(mentionPlainText(segments), hasMention ? mentionRichText(segments) : undefined);
    onHeightChange?.(editor.scrollHeight);
  }, [editorRef, onChange, onHeightChange]);

  const refreshPicker = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const mention = currentMentionQuery(editor);
    if (!mention) {
      setQuery(null);
      queryRef.current = null;
      mentionRange.current = null;
      return;
    }
    mentionRange.current = mention.range;
    if (queryRef.current !== mention.query) setActiveIndex(0);
    queryRef.current = mention.query;
    setQuery(mention.query);
    const visibleCount = options.filter(
      (option) =>
        option.label.toLocaleLowerCase("en-US").includes(mention.query) ||
        option.handle.includes(mention.query)
    ).length;
    const pickerHeight = visibleCount === 0 ? 50 : Math.min(320, visibleCount * 28 + 12);
    const anchorRange = mention.range.cloneRange();
    anchorRange.setStart(mention.range.startContainer, mention.startOffset);
    anchorRange.setEnd(
      mention.range.startContainer,
      Math.min(mention.startOffset + 1, mention.range.startContainer.textContent?.length ?? 0)
    );
    const anchor = anchorRange.getBoundingClientRect();
    const caret = mention.range.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 16);
    setPickerPosition({
      left: Math.round(Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))),
      top: Math.round(Math.max(8, caret.top - pickerHeight - 8)),
    });
  }, [editorRef, options]);

  const insertMention = useCallback(
    (option: MentionOption) => {
      const editor = editorRef.current;
      const range = mentionRange.current;
      if (!editor || !range || range.startContainer.nodeType !== Node.TEXT_NODE) return;
      range.setStart(range.startContainer, Math.max(0, range.startOffset - query!.length - 1));
      range.deleteContents();
      const token = document.createElement("span");
      token.contentEditable = "false";
      token.dataset.mentionId = option.id;
      token.dataset.mentionLabel = option.label;
      token.dataset.mentionHandle = option.handle;
      token.className =
        "mx-1 -mb-[2px] -mt-[3px] inline-flex items-center gap-1 rounded bg-[#e9e9e9] py-0.5 pl-1 pr-1.5 align-baseline text-[14px] font-medium leading-5 text-foreground dark:bg-[#464646]";
      const dot = document.createElement("span");
      dot.className = "grid size-4 shrink-0 place-items-center overflow-hidden";
      const avatar = optionAvatarById.current.get(option.id)?.cloneNode(true);
      if (avatar) dot.append(avatar);
      else {
        dot.classList.add("rounded-full");
        dot.style.backgroundColor = option.color ?? "#8b8b8b";
      }
      const label = document.createElement("span");
      label.textContent = option.label;
      token.append(dot, label);
      const space = document.createTextNode(" ");
      range.insertNode(space);
      range.insertNode(token);
      range.setStartAfter(space);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      setQuery(null);
      queryRef.current = null;
      mentionRange.current = null;
      emit();
      editor.focus();
    },
    [editorRef, emit, query]
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || value || !editor.textContent) return;
    editor.replaceChildren();
    onHeightChange?.(editor.scrollHeight);
  }, [editorRef, onHeightChange, value]);

  useEffect(() => {
    if (query === null || filtered.length === 0) return;
    if (activeIndex >= filtered.length) {
      setActiveIndex(0);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`${listboxId}-option-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, filtered.length, listboxId, query]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (query !== null && filtered.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) =>
          moveMentionSelection(current, filtered.length, event.key === "ArrowDown" ? 1 : -1)
        );
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setActiveIndex(event.key === "Home" ? 0 : filtered.length - 1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const option = filtered[activeIndex];
        if (option) insertMention(option);
        return;
      }
    }
    if (event.key === "Escape" && query !== null) {
      event.preventDefault();
      setQuery(null);
      queryRef.current = null;
      mentionRange.current = null;
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <>
      <div
        aria-label="Message"
        className={cn(
          "whitespace-pre-wrap break-words empty:before:pointer-events-none empty:before:text-[#b7b7b7] empty:before:content-[attr(data-placeholder)] dark:empty:before:text-[#6d6d6d]",
          className
        )}
        contentEditable={!disabled}
        data-placeholder={placeholder}
        aria-activedescendant={
          query !== null && filtered.length > 0
            ? `${listboxId}-option-${activeIndex}`
            : undefined
        }
        aria-autocomplete="list"
        aria-controls={query !== null && filtered.length > 0 ? listboxId : undefined}
        aria-expanded={query !== null}
        aria-haspopup="listbox"
        onBlur={() =>
          window.setTimeout(() => {
            setQuery(null);
            queryRef.current = null;
            mentionRange.current = null;
          }, 120)
        }
        onInput={() => {
          emit();
          refreshPicker();
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          if (!shouldRefreshMentionPickerOnKeyUp(event.key, query !== null)) return;
          refreshPicker();
        }}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
          emit();
          refreshPicker();
        }}
        ref={editorRef}
        role="textbox"
        spellCheck={false}
        suppressContentEditableWarning
      />
      {query !== null && (
        <div
          aria-label="Mention suggestions"
          className="fixed z-[2000] w-[min(360px,calc(100vw-16px))] overflow-hidden rounded-[12px] border-[0.5px] border-[#dedede] bg-[#fcfcfc] shadow-[0_8px_24px_rgba(0,0,0,0.18)] dark:border-[#444] dark:bg-[#2f2f2f]"
          style={pickerPosition}
        >
          {filtered.length === 0 ? (
            <div className="flex flex-col gap-0.5 px-3 py-2 leading-[1.3]">
              <span className="text-[13px] text-foreground">
                {query.trim() ? `No matches for “${query.trim()}”` : "No one to mention yet"}
              </span>
              <span className="text-[11px] text-[#737373] dark:text-[#a8a8a8]">
                Press Esc to close
              </span>
            </div>
          ) : (
            <div className="max-h-80 w-full overscroll-contain overflow-y-auto">
              <ul
                aria-label="Mention"
                className="m-0 list-none px-1.5 py-1.5"
                id={listboxId}
                role="listbox"
              >
                {filtered.map((option, index) => (
                  <li key={option.id} role="presentation">
                    <button
                      aria-selected={index === activeIndex}
                      className={cn(
                        "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-[6px] border-0 bg-transparent px-2 text-left text-[14px] leading-5 text-foreground outline-none",
                        index === activeIndex && "bg-[#e9e9e9] dark:bg-[#464646]"
                      )}
                      data-mention-option-id={option.id}
                      id={`${listboxId}-option-${index}`}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        insertMention(option);
                      }}
                      onPointerMove={() => setActiveIndex(index)}
                      role="option"
                      tabIndex={-1}
                      type="button"
                    >
                      <span
                        className="grid size-4 shrink-0 place-items-center overflow-hidden"
                        data-mention-avatar=""
                        ref={(node) => {
                          if (node) optionAvatarById.current.set(option.id, node);
                          else optionAvatarById.current.delete(option.id);
                        }}
                      >
                        {option.id === "__everyone__" ? (
                          <span className="grid size-4 place-items-center rounded-full bg-[#e9e9e9] text-[11px] font-semibold leading-none text-[#737373] dark:bg-[#464646] dark:text-[#a8a8a8]">
                            @
                          </span>
                        ) : (
                          <BotAvatar
                            bot={{
                              id: option.id,
                              color: option.color ?? "#878787",
                              icon: option.icon ?? "circle",
                              hasAvatar: option.hasAvatar,
                              updatedAt: option.updatedAt,
                            }}
                            size="activity"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      <span className="shrink-0 text-[14px] text-[#737373] dark:text-[#a8a8a8]">
                        Bot
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  );
}
