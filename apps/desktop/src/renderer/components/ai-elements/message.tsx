// Source-owned adaptation of AI Elements message.tsx.
// https://elements.ai-sdk.dev/components/message
import { lazy, memo, Suspense, type ComponentProps, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export function Message({
  from,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { from: "user" | "assistant" | "system" }) {
  return (
    <div
      className={cn(
        "message-row flex w-full flex-col gap-0.5",
        from === "user" ? "items-end" : "items-start",
        className
      )}
      data-role={from}
      {...props}
    />
  );
}

export function MessageContent({
  from,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { from: "user" | "assistant" | "system" }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[16px] px-3 py-2 text-[13px] leading-[1.42]",
        from === "user"
          ? "relative right-0.5 max-w-[min(680px,78%)] bg-[#090909] text-white"
          : "relative left-px max-w-[min(640px,78%)] bg-[#eaeaea] text-[#303030]",
        from === "system" && "border border-amber-500/20 bg-amber-500/8",
        className
      )}
      {...props}
    />
  );
}

const MarkdownMessageResponse = lazy(() => import("./message-response"));
const AdvancedMessageResponse = lazy(() => import("./message-response-rich"));
const MARKDOWN_PATTERN =
  /(?:^|\n)(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~)|\[[^\]]+\]\([^)]+\)|[*_~`]|\\\(|\$\$|<\/?[a-z][^>]*>/i;
const ADVANCED_PATTERN = /```|~~~|\$\$|\\\(|(?:^|\n)```(?:mermaid)?/;

export const MessageResponse = memo(function MessageResponse({ children }: { children: string }) {
  if (!MARKDOWN_PATTERN.test(children)) {
    return <span className="whitespace-pre-wrap">{children}</span>;
  }
  const Renderer = ADVANCED_PATTERN.test(children)
    ? AdvancedMessageResponse
    : MarkdownMessageResponse;
  return (
    <Suspense fallback={<span className="whitespace-pre-wrap">{children}</span>}>
      <Renderer>{children}</Renderer>
    </Suspense>
  );
});

export function MessageActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center gap-0.5 px-1 text-muted-foreground", className)}
      {...props}
    />
  );
}

export function MessageAction({
  tooltip,
  label,
  ...props
}: ComponentProps<typeof Button> & { tooltip: string; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label ?? tooltip} size="icon-sm" variant="ghost" {...props} />
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
