import { BotAvatar } from "./bot-avatar";

const bots = {
  research: { shape: "helmet", color: "#ff7a1a", delay: 0 },
  operations: { shape: "pod", color: "#925df2", delay: 900 },
  engineering: { shape: "chip", color: "#27baae", delay: 1800 },
} as const;

/** Section-relative decoration; stays beside its content as the layout reflows. */
export function SectionBot({
  bot,
  side = "left",
  inline = false,
}: {
  bot: keyof typeof bots;
  side?: "left" | "right";
  inline?: boolean;
}) {
  const identity = bots[bot];
  return (
    <span
      className={`ot-section-bot ${inline ? "ot-section-bot-inline" : `ot-section-bot-${side}`}`}
      aria-hidden="true"
    >
      <BotAvatar
        shape={identity.shape}
        color={identity.color}
        size={64}
        ambient
        blinkDelay={identity.delay}
      />
    </span>
  );
}
