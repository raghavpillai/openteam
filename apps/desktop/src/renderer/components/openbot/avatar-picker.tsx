import { resolveBotAvatarMark } from "@openbot/contracts/bot-avatar";
import { Pipette } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPE_LABELS,
  BOT_AVATAR_SHAPES,
  BotAvatarGlyph,
  type BotAvatarShape,
  botAvatarSwatchBackground,
  normalizeBotAvatarShape,
} from "./avatar-picker-icons";

function PickerShape({
  color,
  selected,
  shape,
}: {
  color: string;
  selected: boolean;
  shape: BotAvatarShape;
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
  const selectedShape = normalizeBotAvatarShape(icon);

  return (
    <PopoverPrimitive.Root onOpenChange={setOpen} open={open}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverPrimitive.Trigger asChild>
            <button
              aria-label="Edit Bot avatar"
              className="group relative grid size-16 place-items-center outline-none"
              type="button"
            >
              <BotAvatarGlyph
                className={cn(
                  "pointer-events-none absolute size-16 overflow-visible transition-opacity duration-100",
                  open ? "opacity-100" : "group-hover:opacity-0 group-focus-visible:opacity-0"
                )}
                color={color}
                shape={selectedShape}
              />
              <BotAvatarGlyph
                className={cn(
                  "pointer-events-none absolute size-16 overflow-visible opacity-0 transition-opacity duration-100",
                  open ? "opacity-0" : "group-hover:opacity-100 group-focus-visible:opacity-100"
                )}
                color={`color-mix(in srgb, ${color}, black 18%)`}
                eyeColor="#a7a7a7"
                outlineColor="#a7a7a7"
                outlineWidth={3}
                shape={selectedShape}
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
          className="z-[110] w-[248px] overflow-hidden rounded-2xl border border-[#e4e4e4] bg-[#fcfcfc] text-foreground shadow-[0_8px_24px_rgba(0,0,0,0.10)] outline-none animate-in fade-in-0 zoom-in-95 dark:border-[#393939] dark:bg-[#181818] dark:shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
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
                onChange({ icon: dealt.shape, color: dealt.color });
              }}
              type="button"
            >
              Reset
            </button>
          </div>

          <div className="px-5 pb-5 pt-[19px]">
            <div className="grid grid-cols-[repeat(4,44px)] justify-center gap-x-3 gap-y-3">
              {BOT_AVATAR_SHAPES.map((shape) => {
                const selected = selectedShape === shape;
                return (
                  <button
                    aria-label={`${BOT_AVATAR_SHAPE_LABELS[shape]} bot avatar`}
                    aria-pressed={selected}
                    className="group grid size-11 place-items-center outline-none"
                    key={shape}
                    onClick={() => onChange({ color, icon: shape })}
                    type="button"
                  >
                    <PickerShape color={color} selected={selected} shape={shape} />
                  </button>
                );
              })}
            </div>

            <div className="mt-7 grid grid-cols-[repeat(5,32px)] justify-center justify-items-center gap-x-2 gap-y-2">
              {BOT_AVATAR_COLORS.map((candidate, index) => {
                const selected = color.toLowerCase() === candidate.toLowerCase();
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
                    onClick={() => onChange({ color: candidate, icon: selectedShape })}
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
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
