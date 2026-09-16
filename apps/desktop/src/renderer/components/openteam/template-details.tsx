import type { BotRecipe } from "@openteam/contracts";
import {
  BookOpen,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Download,
  Globe,
  LockKeyhole,
  Plug,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { BotAvatar } from "./avatar";

type Page =
  | { kind: "overview" }
  | { kind: "context" }
  | { kind: "content"; title: string; content: string; parent: "overview" | "context" };

/** A template is a read-only snapshot. Reviewing it never edits the live Bot. */
export function TemplateDetails({
  recipe,
  version,
  open,
  onOpenChange,
  action,
  busy,
  onAction,
  onDownload,
  error,
}: {
  recipe: BotRecipe;
  version: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: string | null;
  busy: boolean;
  onAction: () => void;
  onDownload: () => void;
  error: string;
}) {
  const [page, setPage] = useState<Page>({ kind: "overview" });
  useEffect(() => {
    if (!open) setPage({ kind: "overview" });
  }, [open]);
  const memory = recipe.memory ?? [];
  const title =
    page.kind === "overview"
      ? recipe.profile.name
      : page.kind === "context"
        ? "Context"
        : page.title;
  const showContent = (
    title: string,
    content: string,
    parent: "overview" | "context" = "overview"
  ) => setPage({ kind: "content", title, content, parent });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(540px,calc(100dvh-40px))] w-[min(400px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-[14px] border-black/10 p-0 shadow-xl dark:border-white/10"
        showCloseButton={false}
      >
        <header className="relative flex h-[52px] shrink-0 items-center justify-center border-b px-12">
          {page.kind !== "overview" && (
            <button
              type="button"
              aria-label={
                page.kind === "context"
                  ? "Back to template"
                  : `Back to ${page.parent === "context" ? "context" : "template"}`
              }
              className="absolute left-3 grid size-8 place-items-center rounded-lg text-foreground-secondary hover:bg-subtle"
              onClick={() => setPage({ kind: page.kind === "content" ? page.parent : "overview" })}
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <DialogTitle className="truncate text-[14px] font-medium leading-5">{title}</DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close template details"
              className="absolute right-3 grid size-8 place-items-center rounded-lg text-foreground-secondary hover:bg-subtle"
            >
              <X className="size-4" />
            </button>
          </DialogClose>
        </header>
        <DialogDescription className="sr-only">
          Review version {version} of this Bot template before publishing.
        </DialogDescription>
        <div className="bot-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {page.kind !== "content" && (
            <div className="mb-4 flex justify-center">
              <BotAvatar
                bot={{
                  color: recipe.profile.avatarColor ?? "#5bc67a",
                  icon: recipe.profile.avatarShape ?? "classic",
                }}
                size="lg"
              />
            </div>
          )}
          {page.kind === "overview" ? (
            <>
              <p className="mb-5 whitespace-pre-wrap text-[14px] leading-5">
                {recipe.profile.description}
              </p>
              <div className="overflow-hidden rounded-xl bg-subtle px-3">
                <TemplateRow
                  title="Context"
                  description="Instructions and memories"
                  icon={<BookOpen className="size-4" />}
                  onClick={() => setPage({ kind: "context" })}
                />
                {(recipe.skills ?? []).map((skill, index) => (
                  <TemplateRow
                    key={`skill-${index}`}
                    title={skill.name}
                    description={skill.description ?? "Skill"}
                    icon={<BookOpen className="size-4" />}
                    onClick={() => showContent(skill.name, skill.content)}
                  />
                ))}
                {(recipe.routines ?? []).map((routine, index) => (
                  <TemplateRow
                    key={`routine-${index}`}
                    title={routine.name ?? routine.slug}
                    description={routine.description}
                    icon={<CalendarClock className="size-4" />}
                    onClick={() => showContent(routine.name ?? routine.slug, routine.content)}
                  />
                ))}
                {(recipe.plugins ?? []).map((plugin, index) => (
                  <TemplateRow
                    key={`plugin-${index}`}
                    title={plugin.name ?? plugin.pluginId}
                    description="Integration"
                    icon={<Plug className="size-4" />}
                    onClick={() =>
                      showContent(
                        plugin.name ?? plugin.pluginId,
                        plugin.description ?? plugin.pluginId
                      )
                    }
                  />
                ))}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={onDownload}
                className="mt-4 flex items-center gap-2 rounded-lg px-2 py-2 text-[12px] text-foreground-secondary hover:bg-subtle"
              >
                <Download className="size-3.5" />
                Download template JSON
              </button>
            </>
          ) : page.kind === "context" ? (
            <>
              <TemplateLabel>Instructions</TemplateLabel>
              <div className="min-h-[148px] whitespace-pre-wrap break-words rounded-xl bg-subtle p-3 text-[14px] leading-5">
                {recipe.profile.description}
              </div>
              <TemplateLabel className="mt-6">Memories</TemplateLabel>
              <div className="overflow-hidden rounded-xl bg-subtle px-3">
                {memory.length ? (
                  memory.map((item, index) => (
                    <TemplateRow
                      key={index}
                      title={item.content}
                      onClick={() => showContent(item.content, item.content, "context")}
                    />
                  ))
                ) : (
                  <p className="py-4 text-[13px] text-foreground-secondary">
                    No memories included.
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <TemplateLabel className="mt-4">Content</TemplateLabel>
              <div className="whitespace-pre-wrap break-words rounded-xl bg-subtle p-3 text-[14px] leading-5">
                {page.content}
              </div>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="px-4 pb-3 text-[12px] text-destructive">
            {error}
          </p>
        )}
        <footer className="flex min-h-[54px] shrink-0 items-center justify-between gap-3 border-t px-4 py-2">
          <span
            className="flex items-center gap-1.5 text-[12px] text-foreground-secondary"
            title={
              recipe.visibility === "public"
                ? "Public after publishing"
                : "People with access to this OpenTeam installation"
            }
          >
            {recipe.visibility === "public" ? (
              <Globe className="size-3.5" />
            ) : (
              <LockKeyhole className="size-3.5" />
            )}
            {recipe.visibility === "public" ? "Public" : "Team only"}
          </span>
          {action && (
            <button
              type="button"
              disabled={busy}
              onClick={onAction}
              className="h-8 min-w-[108px] rounded-[9px] bg-foreground px-4 text-[13px] font-medium text-background disabled:opacity-50"
            >
              {busy ? "Working…" : action}
            </button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function TemplateLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-1.5 px-2 text-[12px] leading-4 text-foreground-secondary ${className}`}>
      {children}
    </div>
  );
}

function TemplateRow({
  title,
  description,
  icon,
  onClick,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[46px] w-full items-center gap-2.5 border-t border-foreground/10 py-2 text-left first:border-t-0 hover:text-foreground-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {icon && <span className="shrink-0 text-foreground-secondary">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-[18px]">{title}</span>
        {description && (
          <span className="block truncate text-[12px] leading-4 text-foreground-secondary">
            {description}
          </span>
        )}
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-foreground-tertiary" />
    </button>
  );
}
