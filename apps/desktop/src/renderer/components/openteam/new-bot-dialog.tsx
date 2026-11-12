import { ButtonPrimitive } from "../ui/button-primitive";
import type { CreateBotInput } from "@openteam/contracts";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_COLOR_NAMES,
  resolveBotAvatarMark,
} from "@openteam/contracts/bot-avatar";
import { ROBOT_AVATAR_LABELS, ROBOT_AVATAR_SHAPES } from "@openteam/contracts/robot-avatar";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { BotAvatarGlyph } from "./avatar-picker-icons";
import "./desktop-panel.css";

// Reference character swatches, in the shared picker’s named color order.
const CHARACTER_COLORS = [
  "#000000",
  "#a06b39",
  "#fb2b3e",
  "#fd690f",
  "#f59312",
  "#14c16f",
  "#13b7a2",
  "#1e86fc",
  "#8f59f9",
  "#f93498",
  "#959595",
] as const;

export function NewBotDialog({
  onOpenChange,
  onCreateBot,
}: {
  onOpenChange: (open: boolean) => void;
  onCreateBot: (input: CreateBotInput) => Promise<void>;
}) {
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [avatar, setAvatar] = useState(() => {
    const initial = resolveBotAvatarMark({ agentId: clientRequestId });
    const index = BOT_AVATAR_COLORS.findIndex((color) => color === initial.color);
    return { ...initial, color: CHARACTER_COLORS[index] ?? initial.color };
  });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const changeOpen = (open: boolean) => {
    if (!submitting.current) onOpenChange(open);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreateBot({
        clientRequestId,
        name: name.trim(),
        icon: avatar.shape,
        color: avatar.color,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(clientErrorMessage(cause, "OpenTeam could not create this Bot"));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={changeOpen}>
      <DialogContent
        className="desktop-parity-panel flex max-h-[calc(100vh-32px)] max-w-[440px] flex-col gap-0 overflow-hidden rounded-[14px] border-foreground/[0.12] bg-white p-0 shadow-none dark:bg-[#1c1c1c]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameRef.current?.focus();
        }}
        showCloseButton={false}
        surface="transparent"
      >
        <form className="flex min-h-0 flex-col" onSubmit={submit}>
          <div className="new-bot-dialog-header flex h-[55px] shrink-0 items-center justify-between border-b pl-4 pr-2.5">
            <DialogTitle className="new-bot-dialog-title">Create New Bot</DialogTitle>
            <Button
              aria-label="Close dialog"
              className="new-bot-dialog-close size-8 rounded-full"
              disabled={busy}
              onClick={() => changeOpen(false)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X className="size-[14px]" strokeWidth={1.5} />
            </Button>
          </div>
          <DialogDescription className="sr-only">
            Name your Bot and choose its character shape and color.
          </DialogDescription>
          <div className="bot-scrollbar min-h-0 overflow-y-auto p-4">
            <div className="flex flex-col gap-3">
              <div aria-label="Bot preview" className="relative h-24 shrink-0">
                <BotAvatarGlyph
                  className="absolute left-1/2 top-1/2 size-32 -translate-x-1/2 -translate-y-1/2 overflow-visible"
                  color={avatar.color}
                  mode="idle"
                  shape={avatar.shape}
                />
              </div>
              <input
                aria-label="Bot name"
                autoComplete="off"
                className="new-bot-name h-9 w-full shrink-0 rounded-lg border border-foreground/[0.12] bg-transparent px-2.5 py-2 text-center text-[13px] outline-none placeholder:text-foreground-secondary"
                disabled={busy}
                maxLength={255}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name your Bot"
                ref={nameRef}
                value={name}
              />
              <div className="flex flex-col items-center gap-3">
                <div
                  aria-label="Character shape"
                  className="flex w-full flex-col gap-2 py-1.5"
                  role="group"
                >
                  {[
                    ROBOT_AVATAR_SHAPES.slice(0, 5),
                    ROBOT_AVATAR_SHAPES.slice(5, 10),
                    ROBOT_AVATAR_SHAPES.slice(10),
                  ].map((row, index) => (
                    <div className="flex justify-center gap-2" key={index}>
                      {row.map((shape) => (
                        <ButtonPrimitive
                          aria-label={`${ROBOT_AVATAR_LABELS[shape]} character shape`}
                          aria-pressed={avatar.shape === shape}
                          className="new-bot-character group grid size-12 shrink-0 place-items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          disabled={busy}
                          key={shape}
                          onClick={() => setAvatar((current) => ({ ...current, shape }))}
                          type="button"
                        >
                          <BotAvatarGlyph
                            className={cn(
                              "absolute size-[46px] overflow-visible",
                              avatar.shape === shape
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                            )}
                            color={avatar.color}
                            outlineColor="var(--panel-outline)"
                            outlineWidth={3.6}
                            shape={shape}
                          />
                          <BotAvatarGlyph
                            className="relative size-[46px] overflow-visible"
                            color={avatar.color}
                            outlineColor={
                              avatar.shape === shape ? "var(--panel-surface)" : undefined
                            }
                            outlineWidth={avatar.shape === shape ? 1.8 : 0}
                            shape={shape}
                          />
                        </ButtonPrimitive>
                      ))}
                    </div>
                  ))}
                </div>
                <div aria-label="Character color" className="flex flex-col gap-2 py-2" role="group">
                  {[CHARACTER_COLORS.slice(0, 6), CHARACTER_COLORS.slice(6)].map((row, index) => (
                    <div className="flex justify-center gap-2" key={index}>
                      {row.map((color) => (
                        <ButtonPrimitive
                          aria-label={`${BOT_AVATAR_COLOR_NAMES[CHARACTER_COLORS.indexOf(color)]} character color`}
                          aria-pressed={avatar.color === color}
                          className={cn(
                            "new-bot-color grid size-8 place-items-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          )}
                          disabled={busy}
                          key={color}
                          onClick={() => setAvatar((current) => ({ ...current, color }))}
                          type="button"
                        >
                          <span className="size-6 rounded-full" style={{ background: color }} />
                        </ButtonPrimitive>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              {error && (
                <p className="text-[13px] text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </div>
          <div className="new-bot-dialog-footer flex shrink-0 justify-end gap-2 border-t px-3 py-3">
            <Button
              className="desktop-panel-button desktop-panel-button-secondary rounded-full"
              disabled={busy}
              onClick={() => changeOpen(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="desktop-panel-button desktop-panel-button-primary rounded-full"
              disabled={!name.trim() || busy}
              type="submit"
              loading={busy}
            >
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
