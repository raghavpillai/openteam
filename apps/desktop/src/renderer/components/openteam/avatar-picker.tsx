import { BOT_AVATAR_COLORS, resolveBotAvatarMark } from "@openteam/contracts/bot-avatar";
import {
  ROBOT_AVATAR_LABELS,
  ROBOT_AVATAR_SHAPES,
  type RobotAvatarShape,
  normalizeRobotAvatarShape,
} from "@openteam/contracts/robot-avatar";
import { Pipette } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useState } from "react";
import { useBotAvatarMode } from "./bot-avatar-activity";
import { cn } from "../../lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { BotAvatarGlyph, botAvatarSwatchBackground } from "./avatar-picker-icons";

function PickerShape({
  color,
  selected,
  shape,
}: {
  color: string;
  selected: boolean;
  shape: RobotAvatarShape;
}) {
  return (
    <span className="relative grid size-9 place-items-center">
      <BotAvatarGlyph
        className={cn(
          "absolute size-9 overflow-visible transition-opacity duration-100",
          selected
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        )}
        color={color}
        outlineColor={
          selected ? "var(--avatar-picker-outline-selected)" : "var(--avatar-picker-outline-hover)"
        }
        outlineWidth={6}
        shape={shape}
      />
      <BotAvatarGlyph
        mode="idle"
        className="relative size-9 overflow-visible"
        color={color}
        outlineColor={selected ? "var(--avatar-picker-outline-inner)" : undefined}
        outlineWidth={3.2}
        shape={shape}
      />
    </span>
  );
}

export function AvatarPicker({
  botId,
  color,
  icon,
  onChange,
}: {
  botId: string;
  color: string;
  icon: string;
  onChange: (next: { color: string; icon: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [draft, setDraft] = useState({ color, icon });
  const changeOpen = (next: boolean) => {
    if (next) setDraft({ color, icon });
    setTooltipOpen(false);
    setOpen(next);
  };
  const activityMode = useBotAvatarMode(botId);
  const previewMode = activityMode === "still" ? "idle" : activityMode;
  const selectedShape = normalizeRobotAvatarShape(draft.icon);
  const savedShape = normalizeRobotAvatarShape(icon);

  return (
    <PopoverPrimitive.Root onOpenChange={changeOpen} open={open}>
      <Tooltip open={!open && tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <PopoverPrimitive.Trigger asChild>
            <button
              aria-label="Edit Bot avatar"
              className="group relative grid size-16 place-items-center outline-none"
              type="button"
            >
              <BotAvatarGlyph
                mode={previewMode}
                className={cn(
                  "pointer-events-none absolute size-16 overflow-visible transition-opacity duration-100",
                  open ? "opacity-100" : "group-hover:opacity-0 group-focus-visible:opacity-0"
                )}
                color={color}
                shape={savedShape}
              />
              <BotAvatarGlyph
                mode={previewMode}
                className={cn(
                  "pointer-events-none absolute size-16 overflow-visible opacity-0 transition-opacity duration-100",
                  open ? "opacity-0" : "group-hover:opacity-100 group-focus-visible:opacity-100"
                )}
                color={`color-mix(in srgb, ${color}, black 18%)`}
                eyeColor="#a7a7a7"
                outlineColor="#a7a7a7"
                outlineWidth={3}
                shape={savedShape}
              />
              <span
                className={cn(
                  "pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-100",
                  open ? "opacity-0" : "group-hover:opacity-100 group-focus-visible:opacity-100"
                )}
              >
                <Pipette
                  className="size-[22px] text-white [filter:drop-shadow(0_1px_0_rgba(80,80,80,0.65))]"
                  strokeWidth={2}
                />
              </span>
            </button>
          </PopoverPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={10}>
          Edit Bot avatar
        </TooltipContent>
      </Tooltip>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="center"
          aria-label="Avatar selector"
          className="floating-surface z-[110] w-[248px] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-2xl border border-[#e4e4e4] bg-[#fcfcfc] text-foreground shadow-[0_8px_24px_rgba(0,0,0,0.10)] outline-none dark:border-[#393939] dark:bg-[#181818] dark:shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
          collisionPadding={8}
          side="bottom"
          sideOffset={6}
        >
          <div className="flex h-[43px] items-center justify-between border-b border-[#e4e4e4] px-4 dark:border-[#303030]">
            <span className="rounded-[9px] bg-[#f0f0f0] px-2 py-1 text-[13px] font-normal leading-[18px] dark:bg-[#2b2b2b]">
              Bot
            </span>
            <button
              className="px-1.5 py-1 text-[13px] leading-[18px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:underline"
              onClick={() => {
                const dealt = resolveBotAvatarMark({ agentId: botId });
                setDraft({ icon: normalizeRobotAvatarShape(dealt.shape), color: dealt.color });
              }}
              type="button"
            >
              Reset
            </button>
          </div>

          <div className="px-5 pb-5 pt-[19px]">
            <div className="grid grid-cols-[repeat(4,44px)] justify-center gap-x-3 gap-y-3">
              {ROBOT_AVATAR_SHAPES.map((shape) => {
                const selected = selectedShape === shape;
                return (
                  <button
                    aria-label={`${ROBOT_AVATAR_LABELS[shape]} bot avatar`}
                    aria-pressed={selected}
                    className="group grid size-11 place-items-center outline-none"
                    key={shape}
                    onClick={() => setDraft((current) => ({ ...current, icon: shape }))}
                    type="button"
                  >
                    <PickerShape color={draft.color} selected={selected} shape={shape} />
                  </button>
                );
              })}
            </div>

            <div className="mt-7 grid grid-cols-[repeat(5,32px)] justify-center justify-items-center gap-x-2 gap-y-2">
              {BOT_AVATAR_COLORS.map((candidate, index) => {
                const selected = draft.color.toLowerCase() === candidate.toLowerCase();
                return (
                  <button
                    aria-label={`${candidate} avatar color`}
                    aria-pressed={selected}
                    className={cn(
                      "grid size-8 place-items-center rounded-full border-2 outline-none transition-colors focus-visible:border-ring",
                      selected
                        ? "border-[#d4d4d4] bg-white dark:border-[#555555] dark:bg-[#242424]"
                        : "border-transparent hover:border-[#ededed] dark:hover:border-[#3a3a3a]",
                      index === BOT_AVATAR_COLORS.length - 1 && "col-start-3"
                    )}
                    key={candidate}
                    onClick={() => setDraft((current) => ({ ...current, color: candidate }))}
                    type="button"
                  >
                    <span
                      className="size-6 rounded-full"
                      style={{
                        background: botAvatarSwatchBackground(candidate),
                      }}
                    />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <button className="rounded-lg px-3 py-1.5 text-[13px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring" onClick={() => changeOpen(false)} type="button">Cancel</button>
            <button className="rounded-lg bg-primary px-3 py-1.5 text-[13px] text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
              onChange(draft);
              changeOpen(false);
            }} type="button">Set avatar</button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
