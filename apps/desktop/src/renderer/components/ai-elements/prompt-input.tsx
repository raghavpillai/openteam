// Source-owned adaptation of AI Elements prompt-input.tsx.
// https://elements.ai-sdk.dev/components/prompt-input
import { ArrowUp, Mic, Plus, Square } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export function PromptInput({
  disabled,
  running,
  placeholder,
  onSubmit,
  onStop,
}: {
  disabled?: boolean;
  running?: boolean;
  placeholder?: string;
  onSubmit: (value: string) => Promise<unknown> | void;
  onStop?: () => Promise<unknown> | void;
}) {
  const [value, setValue] = useState("");
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = value.trim();
    if (!content || disabled || running) return;
    setValue("");
    try {
      await onSubmit(content);
    } catch {
      setValue(content);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };
  return (
    <form className="w-full pb-[22px] pl-[15px] pr-4" onSubmit={submit}>
      <div
        className={cn(
          "flex min-h-10 items-end gap-1 rounded-[20px] border border-[#dedede] bg-background p-1 shadow-none",
          disabled && "opacity-70"
        )}
      >
        <Button
          aria-label="Add attachment"
          className="size-8 rounded-full text-[#888]"
          disabled
          size="icon"
          type="button"
          variant="ghost"
        >
          <Plus className="size-4" />
        </Button>
        <textarea
          aria-label="Message"
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-[13px] leading-5 outline-none placeholder:text-[#a4a4a4]"
          disabled={disabled || running}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          value={value}
        />
        {running ? (
          <Button
            aria-label="Stop run"
            className="size-8 rounded-full"
            onClick={() => void onStop?.()}
            size="icon"
            type="button"
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            aria-label="Send message"
            className="size-8 rounded-full"
            disabled={disabled || value.trim().length === 0}
            size="icon"
            type="submit"
          >
            {value.trim() ? (
              <ArrowUp className="size-4" />
            ) : (
              <Mic className="size-4 fill-current" />
            )}
          </Button>
        )}
      </div>
    </form>
  );
}
