import type { BotView } from "@openbot/contracts";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  Globe2,
  LockKeyhole,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BOT_TEMPLATE_CHANGED_EVENT,
  BOT_TEMPLATE_REQUEST,
  type BotTemplateAudience,
  type BotTemplateRecord,
  botTemplateFor,
  copyBotTemplateLink,
  createBotTemplateDraft,
  deleteBotTemplate,
  publishBotTemplate,
  type TemplateBot,
  updateBotTemplateAudience,
} from "../../lib/bot-template";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { BotAvatar } from "./avatar";

const audienceLabel = (audience: BotTemplateAudience) =>
  audience === "team" ? "Team only" : "Public link";

const AudienceIcon = ({ audience }: { audience: BotTemplateAudience }) =>
  audience === "team" ? <LockKeyhole className="size-3.5" /> : <Globe2 className="size-3.5" />;

export function useBotTemplateRecord(botId: string) {
  const [template, setTemplate] = useState(() => botTemplateFor(botId));
  useEffect(() => {
    setTemplate(botTemplateFor(botId));
    const onChange = (event: Event) => {
      const changedBotId = (event as CustomEvent<{ botId?: string }>).detail?.botId;
      if (!changedBotId || changedBotId === botId) setTemplate(botTemplateFor(botId));
    };
    window.addEventListener(BOT_TEMPLATE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(BOT_TEMPLATE_CHANGED_EVENT, onChange);
  }, [botId]);
  return template;
}

function AudienceMenu({
  template,
  onChange,
  trigger = "labeled",
}: {
  template: BotTemplateRecord;
  onChange: (template: BotTemplateRecord) => void;
  trigger?: "icon" | "labeled";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger === "icon" ? (
          <Button aria-label="Change who can open this link" size="icon-sm" variant="secondary">
            <AudienceIcon audience={template.audience} />
            <ChevronDown className="size-3" />
          </Button>
        ) : (
          <Button className="h-8 gap-1.5 rounded-lg px-2.5 text-xs" variant="ghost">
            <AudienceIcon audience={template.audience} />
            {audienceLabel(template.audience)}
            <ChevronDown className="size-3" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label="Who can open this link" className="w-48">
        {(["team", "public"] as const).map((audience) => (
          <DropdownMenuItem
            key={audience}
            onSelect={() => onChange(updateBotTemplateAudience(template, audience))}
          >
            <span className="grid size-4 place-items-center">
              {template.audience === audience && <Check className="size-3.5" />}
            </span>
            <AudienceIcon audience={audience} />
            {audienceLabel(audience)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PublishAction({
  template,
  onChange,
}: {
  template: BotTemplateRecord;
  onChange: (template: BotTemplateRecord) => void;
}) {
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    []
  );

  if (template.status === "published") {
    return (
      <Button
        className="h-8 rounded-lg px-3 text-xs"
        onClick={() => {
          void copyBotTemplateLink(template).then(() => {
            setCopied(true);
            if (copyTimer.current) window.clearTimeout(copyTimer.current);
            copyTimer.current = window.setTimeout(() => setCopied(false), 1_500);
          });
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy link"}
      </Button>
    );
  }

  return (
    <Button
      className="h-8 rounded-lg px-3 text-xs"
      disabled={publishing}
      onClick={() => {
        setPublishing(true);
        window.setTimeout(() => {
          onChange(publishBotTemplate(template));
          setPublishing(false);
        }, 2_000);
      }}
    >
      <Upload className={cn("size-3.5", publishing && "animate-pulse")} />
      {publishing ? "Publishing…" : "Publish"}
    </Button>
  );
}

export function TemplateAudienceQuestion({
  onDismiss,
  onSelect,
}: {
  onDismiss: () => void;
  onSelect: (audience: BotTemplateAudience) => void;
}) {
  return (
    <div
      className="w-full max-w-[420px] overflow-hidden rounded-xl bg-[#f0f0f0] text-[13px] shadow-sm dark:bg-[#252525]"
      data-bot-template-question=""
    >
      <div className="relative px-3 pb-2.5 pt-3">
        <div className="font-medium">Who should this template be for?</div>
        <p className="mt-0.5 pr-5 text-[12px] leading-[17px] text-muted-foreground">
          Team stays inside your workspace. Public can be shared with anyone.
        </p>
        <button
          aria-label="Dismiss question"
          className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
          onClick={onDismiss}
          type="button"
        >
          <X className="size-3" />
        </button>
      </div>
      <div className="border-t border-black/5 p-1 dark:border-white/5">
        {(["team", "public"] as const).map((audience) => (
          <button
            aria-label={audience === "team" ? "Team" : "Public"}
            className="flex min-h-12 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-black/5 dark:hover:bg-white/5"
            key={audience}
            onClick={() => onSelect(audience)}
            type="button"
          >
            <span className="grid size-4 place-items-center rounded bg-black/[0.06] text-[10px] text-muted-foreground dark:bg-white/10">
              {audience === "team" ? "A" : "B"}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] leading-[17px]">
                {audience === "team" ? "Team" : "Public"}
              </span>
              <span className="block text-[11px] leading-[15px] text-muted-foreground">
                {audience === "team"
                  ? "People in your team can use it"
                  : "Anyone with the link can use it"}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function BotTemplateCard({
  template,
  onChange,
  onView,
}: {
  template: BotTemplateRecord;
  onChange: (template: BotTemplateRecord) => void;
  onView: () => void;
}) {
  return (
    <div
      className="w-full max-w-[420px] rounded-xl border border-border/70 bg-[#f4f4f4] p-3 shadow-sm dark:bg-[#242424]"
      data-bot-template-card={template.status}
    >
      <div className="flex items-center gap-2.5">
        <BotAvatar bot={template.bot} size="md" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{template.bot.name}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {template.status === "published" ? "Published" : "Unpublished"}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <PublishAction onChange={onChange} template={template} />
        <Button className="h-8 rounded-lg px-3 text-xs" onClick={onView} variant="secondary">
          View Details
        </Button>
        <AudienceMenu onChange={onChange} template={template} trigger="icon" />
      </div>
    </div>
  );
}

export function BotTemplateDetailsDialog({
  onChange,
  onOpenChange,
  open,
  template,
}: {
  onChange: (template: BotTemplateRecord) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  template: BotTemplateRecord;
}) {
  const [subview, setSubview] = useState<"summary" | "instructions">("summary");
  useEffect(() => {
    if (!open) setSubview("summary");
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="w-[380px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-[14px] p-0"
        showCloseButton={subview === "summary"}
      >
        <DialogTitle className="sr-only">{template.bot.name}</DialogTitle>
        <DialogDescription className="sr-only">
          Preview and publish this bot template.
        </DialogDescription>
        <div className="min-h-[390px] overflow-hidden">
          <div
            className={cn(
              "flex w-[200%] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              subview === "instructions" && "-translate-x-1/2"
            )}
          >
            <section aria-hidden={subview !== "summary"} className="w-1/2 shrink-0 px-5 pb-4 pt-8">
              <div className="flex flex-col items-center text-center">
                <div className="scale-150 pb-4 pt-3">
                  <BotAvatar bot={template.bot} size="lg" />
                </div>
                <h2 className="mt-3 text-[16px] font-medium">{template.bot.name}</h2>
                <p className="mt-2 max-w-[300px] text-[13px] leading-[18px] text-muted-foreground">
                  {template.bot.description || "A reusable OpenBot template."}
                </p>
              </div>
              <div className="mt-6 overflow-hidden rounded-xl bg-[#f2f2f2] dark:bg-[#202020]">
                <button
                  className="flex h-11 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-black/[0.035] dark:hover:bg-white/[0.035]"
                  onClick={() => setSubview("instructions")}
                  type="button"
                >
                  <span className="flex-1">Instructions</span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              </div>
            </section>
            <section
              aria-hidden={subview !== "instructions"}
              className="w-1/2 shrink-0 px-5 pb-4 pt-5"
            >
              <button
                aria-label="Back"
                className="-ml-1 grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setSubview("summary")}
                type="button"
              >
                <ChevronLeft className="size-4" />
              </button>
              <h2 className="mt-2 text-[15px] font-medium">Instructions</h2>
              <div className="mt-4 max-h-[275px] overflow-y-auto whitespace-pre-wrap rounded-xl bg-[#f2f2f2] p-3 text-[12px] leading-[18px] dark:bg-[#202020]">
                {template.bot.instructions || "No custom instructions."}
              </div>
            </section>
          </div>
        </div>
        <div className="flex min-h-14 items-center justify-between gap-2 border-t px-3 py-2">
          <AudienceMenu onChange={onChange} template={template} />
          <PublishAction onChange={onChange} template={template} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BotTemplateSettingsFooter({ bot, onShare }: { bot: BotView; onShare: () => void }) {
  const storedTemplate = useBotTemplateRecord(bot.id);
  const [template, setTemplate] = useState(storedTemplate);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => setTemplate(storedTemplate), [storedTemplate]);

  if (!template || template.status !== "published") {
    return (
      <Button
        aria-label="Share as template"
        className="h-8 w-full rounded-[7px] bg-[#f0f0f0] text-[12px] font-normal shadow-none hover:bg-[#e8e8e8] dark:bg-[#181818] dark:hover:bg-[#232323]"
        onClick={onShare}
        type="button"
        variant="secondary"
      >
        <Upload className="size-3.5" />
        Share as template
      </Button>
    );
  }

  return (
    <>
      <div className="mb-1 text-center text-[11px] text-muted-foreground">
        Last updated{" "}
        {new Date(template.updatedAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })}
      </div>
      <div className="flex gap-1.5">
        <Button
          className="h-8 min-w-0 flex-1 rounded-[7px] text-[12px] font-normal"
          onClick={() => setDetailsOpen(true)}
          variant="secondary"
        >
          <Upload className="size-3.5" />
          View shared template
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Template actions"
              className="size-8 rounded-[7px]"
              size="icon-sm"
              variant="secondary"
            >
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label="Template actions" className="w-52">
            <DropdownMenuItem
              onSelect={() =>
                setTemplate(
                  updateBotTemplateAudience(
                    template,
                    template.audience === "team" ? "public" : "team"
                  )
                )
              }
            >
              <AudienceIcon audience={template.audience === "team" ? "public" : "team"} />
              {template.audience === "team" ? "Public link" : "Team only"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onShare}>
              <RefreshCw className="size-4" /> Update Bot
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => {
                if (
                  !window.confirm(
                    `Delete “${template.bot.name}”?\n\nThis deletes the template and turns off its shared link.`
                  )
                )
                  return;
                deleteBotTemplate(template);
                setTemplate(null);
              }}
            >
              <Trash2 className="size-4" /> Delete shared link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <BotTemplateDetailsDialog
        onChange={setTemplate}
        onOpenChange={setDetailsOpen}
        open={detailsOpen}
        template={template}
      />
    </>
  );
}

export function BotTemplateConversationFlow({
  bot,
  onSubmitPrompt,
  request,
}: {
  bot: BotView;
  onSubmitPrompt: (content: string) => Promise<unknown>;
  request: { botId: string; nonce: number };
}) {
  const [flow, setFlow] = useState<
    { stage: "audience" } | { stage: "draft"; template: BotTemplateRecord } | null
  >(null);
  const [preview, setPreview] = useState<BotTemplateRecord | null>(null);
  const handledRequest = useRef<number | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const storedTemplate = useBotTemplateRecord(bot.id);

  useEffect(() => {
    if (request.botId !== bot.id || handledRequest.current === request.nonce) return;
    handledRequest.current = request.nonce;
    const existing = botTemplateFor(bot.id);
    if (existing?.status === "published") {
      setPreview(existing);
      setFlow(null);
      return;
    }
    setFlow(null);
    void onSubmitPrompt(BOT_TEMPLATE_REQUEST).then(
      () => {
        if (handledRequest.current === request.nonce) setFlow({ stage: "audience" });
      },
      () => undefined
    );
  }, [bot.id, onSubmitPrompt, request]);

  useEffect(() => {
    setFlow((current) => {
      if (storedTemplate) {
        return current?.stage === "audience"
          ? current
          : { stage: "draft", template: storedTemplate };
      }
      return current?.stage === "draft" ? null : current;
    });
  }, [storedTemplate]);

  useEffect(() => {
    if (!flow) return;
    const frame = window.requestAnimationFrame(() => {
      flowRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "end",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flow]);

  return (
    <>
      {flow && (
        <div className="mt-2 flex flex-col gap-2 px-2 pb-1" data-bot-template-flow="" ref={flowRef}>
          <div className="mr-auto flex w-full max-w-[560px] items-end gap-2">
            <div aria-label={`${bot.name} is working`} role="status">
              <BotAvatar bot={bot} size="activity" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 text-[13px] leading-[18px] text-foreground-secondary">
                {flow.stage === "audience"
                  ? "I’ll pull together a shareable template of this bot."
                  : `${flow.template.audience === "team" ? "Team" : "Public"} template ready.`}
              </div>
              {flow.stage === "audience" ? (
                <TemplateAudienceQuestion
                  onDismiss={() => setFlow(null)}
                  onSelect={(audience) => {
                    setFlow({
                      stage: "draft",
                      template: createBotTemplateDraft(bot, audience),
                    });
                  }}
                />
              ) : (
                <BotTemplateCard
                  onChange={(template) => setFlow({ stage: "draft", template })}
                  onView={() => setPreview(flow.template)}
                  template={flow.template}
                />
              )}
            </div>
          </div>
        </div>
      )}
      {preview && (
        <BotTemplateDetailsDialog
          onChange={(template) => {
            setPreview(template);
            setFlow((current) =>
              current?.stage === "draft" ? { stage: "draft", template } : current
            );
          }}
          onOpenChange={(open) => !open && setPreview(null)}
          open
          template={preview}
        />
      )}
    </>
  );
}

export function BotTemplateImportDialog({
  onAdd,
  onOpenChange,
  open,
  template,
}: {
  onAdd: (template: TemplateBot) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  template: TemplateBot | null;
}) {
  const [adding, setAdding] = useState(false);
  const description = useMemo(
    () => template?.description || "A shared OpenBot template.",
    [template]
  );
  if (!template) return null;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="w-[380px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-[14px] p-0">
        <DialogTitle className="sr-only">Add {template.name}</DialogTitle>
        <DialogDescription className="sr-only">Preview this shared bot template.</DialogDescription>
        <div className="flex min-h-[330px] flex-col items-center px-6 pb-6 pt-10 text-center">
          <div className="scale-150 pb-4 pt-3">
            <BotAvatar bot={template} size="lg" />
          </div>
          <h2 className="mt-4 text-[17px] font-medium">{template.name}</h2>
          <p className="mt-2 max-w-[300px] text-[13px] leading-[18px] text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="flex justify-end border-t px-3 py-2">
          <Button
            className="h-8 rounded-lg px-4 text-xs"
            disabled={adding}
            onClick={() => {
              setAdding(true);
              void onAdd(template)
                .catch(() => undefined)
                .finally(() => setAdding(false));
            }}
          >
            {adding ? "Adding…" : "Add Bot"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
