// Source-owned adaptation of AI Elements message.tsx.
// https://elements.ai-sdk.dev/components/message
import { type ComponentProps, type HTMLAttributes, lazy, memo, Suspense } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export function Message({
  from,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant" | "system";
}) {
  return (
    <div
      className={cn(
        "message-row flex w-full flex-col gap-0.5",
        from === "user" ? "items-end" : "items-start",
        className
      )}
      data-role={from}
      {...props}
    >
      <div
        className={cn(
          "message-row-content flex w-full flex-col gap-0.5",
          from === "user" ? "items-end" : "items-start"
        )}
      >
        {children}
      </div>
    </div>
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
        "message-bubble overflow-hidden",
        from === "system" && "border border-amber-500/20 bg-amber-500/8",
        className
      )}
      data-role={from}
      {...props}
    />
  );
}

const MarkdownMessageResponse = lazy(() => import("./message-response"));
const AdvancedMessageResponse = lazy(() => import("./message-response-rich"));
const MARKDOWN_PATTERN =
  /(?:^|\n)(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~)|\[[^\]]+\]\([^)]+\)|(?:^|[\s([{])(?:\*{1,2}|_{1,2}|~{2})(?=\S)|`|<\/?[a-z][^>]*>/i;
const ADVANCED_PATTERN = /```|~~~|\$\$|\\[[(]|(?:^|[^\\$])\$(?![$\s])(?:\\.|[^$\n])+\$/;

export const messageNeedsMarkdown = (content: string) =>
  MARKDOWN_PATTERN.test(content) || ADVANCED_PATTERN.test(content);

export const MessageResponse = memo(function MessageResponse({ children }: { children: string }) {
  if (!messageNeedsMarkdown(children)) {
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
