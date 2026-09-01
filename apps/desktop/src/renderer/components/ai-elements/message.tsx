// Source-owned adaptation of AI Elements message.tsx.
// https://elements.ai-sdk.dev/components/message
import { messageContainsMarkdownSyntax } from "@openbot/product-core/markdown";
import { type ComponentProps, type HTMLAttributes, lazy, memo, Suspense } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  advancedMessageCapabilitiesFor,
  messageNeedsAdvancedRenderer,
} from "./message-response-capabilities";
import { loadAdvancedMessagePlugins } from "./message-response-plugins";

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
const messageContainsDesktopMarkup = (content: string) =>
  messageContainsMarkdownSyntax(content) || /<\/?[a-z][^>]*>/i.test(content);
export const messageNeedsMarkdown = (content: string) =>
  messageContainsDesktopMarkup(content) || messageNeedsAdvancedRenderer(content);

export const MessageResponse = memo(function MessageResponse({ children }: { children: string }) {
  const capabilities = advancedMessageCapabilitiesFor(children);
  if (!messageContainsDesktopMarkup(children) && !capabilities) {
    return <span className="whitespace-pre-wrap">{children}</span>;
  }
  if (capabilities) {
    // Begin the selected plug-in requests in parallel with the lazy Streamdown
    // renderer. The rich component consumes this same cached promise.
    void loadAdvancedMessagePlugins(capabilities);
  }
  if (capabilities) {
    return (
      <Suspense fallback={<span className="whitespace-pre-wrap">{children}</span>}>
        <AdvancedMessageResponse capabilities={capabilities}>{children}</AdvancedMessageResponse>
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<span className="whitespace-pre-wrap">{children}</span>}>
      <MarkdownMessageResponse>{children}</MarkdownMessageResponse>
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
