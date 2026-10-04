import { type BotRecipe, type ChannelMessageView } from "@openteam/contracts";
import { useEffect, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import { api } from "../../client/openteam-api";
import { BotAvatar } from "./avatar";
import { TemplateDetails } from "./template-details";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
export function SharedTemplateCard({ message }: { message: ChannelMessageView }) {
  const inFlight = useRef(false);
  const metadata = message.metadata as Record<string, unknown>;
  const template = metadata.template as Record<string, any>;
  const [state, setState] = useState(String(metadata.cardState ?? "published"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imported, setImported] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [importId] = useState(() => crypto.randomUUID());
  useEffect(() => setState(String(metadata.cardState ?? "published")), [metadata.cardState]);
  const act = async (action: "import" | "unpublish") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.mutateSharedTemplate(message.id, action, importId);
      setState(String((result.message.metadata as Record<string, unknown>).cardState));
      if (result.botId) setImported(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The template action could not be completed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const download = async () => {
    try {
      const recipe = await api.sharedTemplateRecipe(message.id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(recipe, null, 2)], { type: "application/json" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "bot-template.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError("The template could not be downloaded");
    }
  };
  {
    const recipe = template.recipe as BotRecipe;
    const tint = /^#[0-9a-f]{6}$/i.test(recipe.profile.avatarColor ?? "")
      ? recipe.profile.avatarColor!
      : "#5bc67a";
    const primaryLabel = state === "published" && !imported ? "Use template" : null;
    const primaryAction = () => void act("import");
    return (
      <>
        <div className="rich-message-card flex w-[300px] max-w-full flex-col gap-3 rounded-[14px] bg-message-assistant p-3 text-[13px] leading-[18px]">
          <div className="flex items-center gap-2">
            <strong className="min-w-0 flex-1 truncate font-medium">{recipe.profile.name}</strong>
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.04] px-2 py-0.5 text-[11px] text-foreground-secondary">
              <span
                className={`size-1.5 rounded-full ${state === "published" ? "bg-[#5bc67a]" : "bg-foreground-tertiary"}`}
              />
              {state === "published"
                ? "Published"
                : state === "unpublished"
                  ? "Unpublished"
                  : String(metadata.outcomeText ?? state)}
            </span>
          </div>
          <button
            type="button"
            aria-label={`View ${recipe.profile.name} template`}
            onClick={() => setDetailsOpen(true)}
            style={{
              background: `linear-gradient(135deg, color-mix(in srgb, ${tint} 30%, var(--message-assistant)), color-mix(in srgb, ${tint} 5%, var(--message-assistant)))`,
            }}
            className="grid aspect-[5/3] w-full place-items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring [&>span]:size-[104px]"
          >
            <BotAvatar
              bot={{
                color: recipe.profile.avatarColor ?? "#5bc67a",
                icon: recipe.profile.avatarShape ?? "classic",
              }}
              size="lg"
            />
          </button>
          <p className="line-clamp-2 whitespace-pre-wrap text-foreground-secondary">
            {recipe.profile.description}
          </p>
          <div className="flex gap-2">
            {primaryLabel && (
              <button
                type="button"
                disabled={busy}
                onClick={primaryAction}
                className="h-8 flex-1 rounded-[8px] bg-foreground px-3 font-medium text-background disabled:opacity-50"
              >
                {busy ? "Working…" : primaryLabel}
              </button>
            )}
            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              className="h-8 flex-1 rounded-[8px] border border-foreground/10 bg-background/60 px-3 hover:bg-background"
            >
              View Details
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Template actions"
                  className="grid size-8 shrink-0 place-items-center rounded-lg text-foreground-secondary hover:bg-background/60"
                >
                  <Ellipsis className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="text-[13px]">
                <DropdownMenuItem onSelect={() => void download()}>
                  Download template JSON
                </DropdownMenuItem>
                {state === "published" && (
                  <DropdownMenuItem disabled={busy} onSelect={() => void act("unpublish")}>
                    Unpublish
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {imported && (
            <p role="status" className="text-[12px] text-foreground-secondary">
              Bot created — open it from the sidebar
            </p>
          )}
          {error && (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          )}
        </div>
        <TemplateDetails
          recipe={recipe}
          version={Number(template.version)}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          action={primaryLabel}
          busy={busy}
          onAction={primaryAction}
          updatedAt={message.createdAt}
          error={error}
        />
      </>
    );
  }
}
