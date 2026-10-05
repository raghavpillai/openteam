// Source-owned adaptation of AI Elements message.tsx.
// https://elements.ai-sdk.dev/components/message
import { messageContainsMarkdownSyntax } from "@openteam/product-core/markdown";
import {
  Component,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
  lazy,
  memo,
  Suspense,
} from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  advancedMessageCapabilitiesFor,
  messageNeedsAdvancedRenderer,
} from "./message-response/capabilities";
import { loadAdvancedMessagePlugins } from "./message-response/plugins";

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
          "message-row-content relative flex w-full flex-col gap-0.5",
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
const AdvancedMessageResponse = lazy(() => import("./message-response/rich"));
const messageContainsDesktopMarkup = (content: string) =>
  messageContainsMarkdownSyntax(content) || /<\/?[a-z][^>]*>/i.test(content);
export const messageNeedsMarkdown = (content: string) =>
  messageContainsDesktopMarkup(content) || messageNeedsAdvancedRenderer(content);

export class MessageRendererBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    // Failed renderer imports must leave readable content and release the
    // opening barrier. Raw text has synchronous, measurable geometry.
    return this.state.failed ? (
      <span data-chat-renderer-fallback className="whitespace-pre-wrap">
        {this.props.content}
      </span>
    ) : (
      this.props.children
    );
  }
}

export const MessageResponse = memo(function MessageResponse({ children }: { children: string }) {
  const capabilities = advancedMessageCapabilitiesFor(children);
  if (!messageContainsDesktopMarkup(children) && !capabilities) {
    return <span className="whitespace-pre-wrap">{children}</span>;
  }
  if (capabilities) {
    // Begin the selected plug-in requests in parallel with the lazy Streamdown
    // renderer.
    // The renderer consumes this same promise inside the boundary below.
    // Handle speculative rejection until the lazy component mounts.
    void loadAdvancedMessagePlugins(capabilities).catch(() => {});
  }
  if (capabilities) {
    return (
      <MessageRendererBoundary content={children}>
        <Suspense
          fallback={
            <span data-chat-layout-pending className="whitespace-pre-wrap">
              {children}
            </span>
          }
        >
          <AdvancedMessageResponse capabilities={capabilities}>{children}</AdvancedMessageResponse>
        </Suspense>
      </MessageRendererBoundary>
    );
  }
  return (
    <MessageRendererBoundary content={children}>
      <Suspense
        fallback={
          <span data-chat-layout-pending className="whitespace-pre-wrap">
            {children}
          </span>
        }
      >
        <MarkdownMessageResponse>{children}</MarkdownMessageResponse>
      </Suspense>
    </MessageRendererBoundary>
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
