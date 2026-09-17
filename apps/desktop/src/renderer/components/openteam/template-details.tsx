import "./template-details.css";
import type { BotRecipe } from "@openteam/contracts";
import { ChevronLeft, ChevronRight, Globe, LockKeyhole, Plug, X } from "lucide-react";
import { ScrollArea } from "radix-ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { BotAvatar } from "./avatar";

type Page =
  | { kind: "overview" }
  | { kind: "context" }
  | { kind: "routines" }
  | { kind: "integrations" }
  | {
      kind: "content";
      title: string;
      description?: string;
      content: string;
      parent: "context" | "routines";
    };

/** A template is a read-only snapshot. Reviewing it never edits the live Bot. */
export function TemplateDetails({
  recipe,
  version,
  open,
  onOpenChange,
  action,
  busy,
  onAction,
  updatedAt,
  error,
}: {
  recipe: BotRecipe;
  version: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: string | null;
  busy: boolean;
  onAction: () => void;
  updatedAt?: string;
  error: string;
}) {
  const [page, setPage] = useState<Page>({ kind: "overview" });
  const [transition, setTransition] = useState<{
    from: Page;
    direction: "push" | "pop";
    serial: number;
  } | null>(null);
  const serial = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const landOn = useRef<string | "back" | null>(null);
  const trail = useRef<string[]>([]);
  useLayoutEffect(() => {
    if (open) {
      setPage({ kind: "overview" });
      setTransition(null);
      trail.current = [];
      landOn.current = null;
    }
  }, [open]);
  useEffect(() => {
    if (!transition) return;
    const timer = window.setTimeout(
      () => setTransition((current) => (current?.serial === transition.serial ? null : current)),
      250
    );
    return () => window.clearTimeout(timer);
  }, [transition]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore focus after the selected page commits.
  useLayoutEffect(() => {
    const target = landOn.current;
    if (!target) return;
    landOn.current = null;
    if (scroll.current) scroll.current.scrollTop = 0;
    const element =
      target === "back"
        ? back.current
        : Array.from(
            pane.current?.querySelectorAll<HTMLElement>("[data-template-target]") ?? []
          ).find((item) => item.dataset.templateTarget === target);
    element?.focus({ preventScroll: true });
  }, [page]);
  const navigate = (next: Page, direction: "push" | "pop", target?: string) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTransition(reduce ? null : { from: page, direction, serial: ++serial.current });
    if (direction === "push") {
      trail.current.push(target ?? "context");
      landOn.current = "back";
    } else landOn.current = trail.current.pop() ?? "context";
    setPage(next);
  };
  const memory = recipe.memory ?? [];
  const skills = recipe.skills ?? [];
  const routines = recipe.routines ?? [];
  const plugins = recipe.plugins ?? [];
  const firstRoutineName = routines[0]?.name ?? routines[0]?.slug ?? "";
  const contextParts = [
    recipe.profile.description.trim() && "Instructions",
    memory.length && "memories",
    skills.length && "skills",
  ].filter(Boolean) as string[];
  const contextDescription = new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(contextParts);
  const updatedDate = updatedAt ? new Date(updatedAt) : null;
  const updatedLabel =
    updatedDate && Number.isFinite(updatedDate.getTime())
      ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(updatedDate)
      : null;
  const title =
    page.kind === "overview"
      ? recipe.profile.name
      : page.kind === "content"
        ? page.title
        : page.kind === "context"
          ? "Context"
          : page.kind === "routines"
            ? "Routines"
            : "Integrations";
  const showContent = (
    title: string,
    content: string,
    parent: "context" | "routines",
    target: string,
    description?: string
  ) => navigate({ kind: "content", title, content, description, parent }, "push", target);
  const renderPage = (page: Page) => (
    <>
      {page.kind === "overview" ? (
        <>
          <h3 className="text-center text-[17px] font-medium leading-6 tracking-[-0.008em]">
            {recipe.profile.name}
          </h3>
          {updatedLabel && (
            <p className="mt-0.5 text-center text-[13px] leading-[18px] text-foreground-secondary">
              Last updated {updatedLabel}
            </p>
          )}
          {recipe.profile.description.trim() && (
            <p className="mt-1.5 line-clamp-3 text-center text-[14px] leading-5 text-foreground-secondary">
              {recipe.profile.description.replace(/\s+/g, " ").trim()}
            </p>
          )}
          {(contextParts.length > 0 || routines.length > 0 || plugins.length > 0) && (
            <div className="template-card mt-6 overflow-hidden rounded-xl p-1">
              {contextParts.length > 0 && (
                <TemplateRow
                  title="Context"
                  description={contextDescription}
                  target="context"
                  onClick={() => navigate({ kind: "context" }, "push", "context")}
                />
              )}
              {routines.length > 0 && (
                <TemplateRow
                  title="Routines"
                  description={
                    routines.length === 1
                      ? firstRoutineName
                      : `${firstRoutineName} and ${routines.length - 1} more`
                  }
                  target="routines"
                  onClick={() => navigate({ kind: "routines" }, "push", "routines")}
                />
              )}
              {plugins.length > 0 && (
                <TemplateRow
                  title="Integrations"
                  description={plugins.map((plugin) => plugin.name ?? plugin.pluginId).join(", ")}
                  target="integrations"
                  onClick={() => navigate({ kind: "integrations" }, "push", "integrations")}
                />
              )}
            </div>
          )}
        </>
      ) : page.kind === "context" ? (
        <div className="space-y-4">
          {recipe.profile.description.trim() && (
            <section>
              <TemplateLabel>Instructions</TemplateLabel>
              <div className="template-card min-h-[148px] whitespace-pre-wrap break-words rounded-xl p-3.5 text-[14px] leading-5">
                {recipe.profile.description}
              </div>
            </section>
          )}
          {memory.length > 0 && (
            <section>
              <TemplateLabel>Memories</TemplateLabel>
              <div className="template-card overflow-hidden rounded-xl p-1">
                {memory.map((item, index) => (
                  <TemplateRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: Immutable snapshots can contain duplicate facts.
                    key={`${index}:${item.content}`}
                    target={`memory-${index}`}
                    title={item.content}
                    onClick={() =>
                      showContent(item.content, item.content, "context", `memory-${index}`)
                    }
                  />
                ))}
              </div>
            </section>
          )}
          {skills.length > 0 && (
            <section>
              <TemplateLabel>Skills</TemplateLabel>
              <div className="template-card overflow-hidden rounded-xl p-1">
                {skills.map((skill, index) => (
                  <TemplateRow
                    key={skill.name}
                    target={`skill-${index}`}
                    title={skill.name}
                    onClick={() =>
                      showContent(
                        skill.name,
                        skill.content,
                        "context",
                        `skill-${index}`,
                        skill.description
                      )
                    }
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      ) : page.kind === "routines" ? (
        <div className="template-card overflow-hidden rounded-xl p-1">
          {routines.map((routine, index) => (
            <TemplateRow
              key={routine.slug}
              target={`routine-${index}`}
              title={routine.name ?? routine.slug}
              onClick={() =>
                showContent(
                  routine.name ?? routine.slug,
                  routine.content,
                  "routines",
                  `routine-${index}`,
                  routine.description
                )
              }
            />
          ))}
        </div>
      ) : page.kind === "integrations" ? (
        <div className="template-card overflow-hidden rounded-xl p-1">
          {plugins.map((plugin, index) => (
            <TemplateRow
              key={plugin.pluginId}
              target={`plugin-${index}`}
              title={plugin.name ?? plugin.pluginId}
              description={plugin.description}
              icon={<Plug className="size-5" />}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {page.description && (
            <section>
              <TemplateLabel>Description</TemplateLabel>
              <div className="template-card whitespace-pre-wrap break-words rounded-xl p-3.5 text-[14px] leading-5">
                {page.description}
              </div>
            </section>
          )}
          <section>
            <TemplateLabel>Content</TemplateLabel>
            <div className="template-card whitespace-pre-wrap break-words rounded-xl p-3.5 text-[14px] leading-5">
              {page.content}
            </div>
          </section>
        </div>
      )}
    </>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={dialog}
        overlayClassName="template-overlay"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialog.current?.focus();
        }}
        className="template-details flex h-[min(540px,calc(100dvh-40px))] w-[min(400px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-[14px] border-[0.5px] border-[#14141426] p-0 shadow-xl dark:border-white/10"
        showCloseButton={false}
      >
        <header
          className="template-header absolute inset-x-0 top-0 z-20 flex h-[52px] items-center gap-4 border-b-[0.5px] border-foreground/10 bg-background py-3 pl-4 pr-2.5"
          data-overview={page.kind === "overview"}
        >
          {page.kind !== "overview" && (
            <button
              ref={back}
              type="button"
              aria-label={page.kind !== "content" ? "Back to template" : `Back to ${page.parent}`}
              className="grid size-7 shrink-0 place-items-center rounded-lg text-foreground-secondary hover:bg-subtle"
              onClick={() =>
                navigate({ kind: page.kind === "content" ? page.parent : "overview" }, "pop")
              }
            >
              <ChevronLeft className="size-4" strokeWidth={1.5} />
            </button>
          )}
          <div className="min-w-0 flex-1 overflow-hidden">
            <DialogTitle
              className={
                page.kind === "overview"
                  ? "sr-only"
                  : "whitespace-nowrap text-center text-[14px] font-medium leading-5"
              }
            >
              {title}
            </DialogTitle>
          </div>
          {page.kind !== "overview" && <span aria-hidden className="size-7 shrink-0" />}
        </header>
        <DialogClose asChild>
          <button
            type="button"
            aria-label="Close template details"
            className="sr-only focus:not-sr-only focus:absolute focus:right-3 focus:top-3 focus:z-30 focus:grid focus:size-7 focus:place-items-center focus:rounded-lg focus:bg-subtle"
          >
            <X className="size-4" />
          </button>
        </DialogClose>
        <DialogDescription className="sr-only">
          Review version {version} of this Bot template before publishing.
        </DialogDescription>
        <ScrollArea.Root type="hover" className="relative min-h-0 flex-1 overflow-hidden">
          <ScrollArea.Viewport
            ref={scroll}
            className="h-full w-full [&>div]:!grid [&>div]:min-h-full"
          >
            <div className="template-page-viewport relative flex min-h-full min-w-0 flex-col">
              {page.kind !== "content" && (
                <div aria-hidden className="relative z-10 shrink-0 px-4 pt-8">
                  <div
                    className="template-mark pointer-events-none flex justify-center [&>span]:size-20"
                    data-compact={page.kind !== "overview"}
                  >
                    <BotAvatar
                      bot={{
                        color: recipe.profile.avatarColor ?? "#5bc67a",
                        icon: recipe.profile.avatarShape ?? "classic",
                      }}
                      size="lg"
                    />
                  </div>
                </div>
              )}
              <div className="template-navigation relative isolate min-w-0 grow shrink-0 overflow-hidden bg-background">
                {transition && (
                  <div
                    key={`out-${transition.serial}`}
                    className="template-page outgoing absolute inset-0 px-4 pb-5"
                    data-direction={transition.direction}
                    data-page={transition.from.kind}
                    aria-hidden
                    inert
                  >
                    {renderPage(transition.from)}
                  </div>
                )}
                <div
                  key={`${page.kind}-${page.kind === "content" ? page.title : ""}`}
                  ref={pane}
                  className="template-page relative min-h-full px-4 pb-5"
                  data-direction={transition?.direction}
                  data-page={page.kind}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget)
                      setTransition((current) =>
                        current?.serial === transition?.serial ? null : current
                      );
                  }}
                >
                  {renderPage(page)}
                </div>
              </div>
            </div>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar
            orientation="vertical"
            className="z-30 flex w-2 touch-none select-none p-0.5"
          >
            <ScrollArea.Thumb className="relative flex-1 rounded-full bg-foreground/20" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
        {error && (
          <p role="alert" className="px-4 pb-3 text-[12px] text-destructive">
            {error}
          </p>
        )}
        <footer className="flex min-h-[54px] shrink-0 items-center justify-between gap-2 border-t-[0.5px] border-foreground/10 pb-3 pl-4 pr-3 pt-2.5">
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
              className="template-publish h-8 min-w-[108px] rounded-lg px-2.5 text-[14px] font-normal leading-5"
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
    <div
      className={`h-[30px] px-2 pb-1.5 pt-2 text-[12px] leading-4 text-foreground-secondary ${className}`}
    >
      {children}
    </div>
  );
}

function TemplateRow({
  target,
  title,
  description,
  icon,
  onClick,
}: {
  target: string;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
}) {
  const Row = onClick ? "button" : "div";
  return (
    <Row
      type={onClick ? "button" : undefined}
      onClick={onClick}
      data-template-target={onClick ? target : undefined}
      className="template-row relative flex min-h-[46px] w-full items-center gap-2.5 px-2.5 py-2.5 text-left hover:text-foreground-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {icon && <span className="shrink-0 text-foreground-secondary">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] leading-5">{title}</span>
        {description && (
          <span className="block truncate text-[13px] leading-[18px] text-foreground-secondary">
            {description}
          </span>
        )}
      </span>
      {onClick && <ChevronRight className="size-3.5 shrink-0 text-foreground-tertiary" />}
    </Row>
  );
}
