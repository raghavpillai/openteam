// Source-owned adaptation of AI Elements conversation.tsx.
// Upstream: vercel/ai-elements@6a9d5b1822ffb10bba4bd97175f01edd7d8651cd
import { ArrowDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export const Conversation = ({ className, ...props }: ComponentProps<typeof StickToBottom>) => (
  <StickToBottom
    className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export const ConversationContent = ({
  className,
  ...props
}: ComponentProps<typeof StickToBottom.Content>) => (
  <StickToBottom.Content
    className={cn("mx-auto flex w-full max-w-4xl flex-col gap-6 py-8", className)}
    {...props}
  />
);

export const ConversationEmptyState = ({
  title = "Start a conversation",
  description = "This bot keeps one durable Pi session across restarts.",
  icon,
}: {
  title?: string;
  description?: string;
  icon?: ReactNode;
}) => (
  <div className="flex h-full min-h-80 flex-col items-center justify-center gap-2 text-center">
    {icon && <div className="mb-2 text-muted-foreground">{icon}</div>}
    <div className="text-base font-medium">{title}</div>
    <div className="max-w-sm text-sm text-neutral-500">{description}</div>
  </div>
);

export const ConversationScrollButton = () => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const onClick = useCallback(() => scrollToBottom(), [scrollToBottom]);
  if (isAtBottom) return null;
  return (
    <Button
      aria-label="Scroll to newest message"
      className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg"
      onClick={onClick}
      size="icon"
      variant="secondary"
    >
      <ArrowDown className="size-4" />
    </Button>
  );
};
