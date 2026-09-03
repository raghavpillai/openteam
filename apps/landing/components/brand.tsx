import { BotAvatar } from "./bot-avatar";

export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-ink">
      <BotAvatar shape="blob" color="#141414" eyeColor="#fbfbfa" size={size} />
      <span
        className="font-display tracking-[-0.01em]"
        style={{ fontSize: Math.round(size * 1.18), lineHeight: 1 }}
      >
        OpenBot
      </span>
    </span>
  );
}
