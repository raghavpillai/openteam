import chatGPTIcon from "../../../assets/model-providers/chatgpt.webp";
import claudeIcon from "../../../assets/model-providers/claude.webp";
import { isTileProvider, ProviderTile } from "./provider-marks";

// The ChatGPT and Claude app icons from their App Store listings (downloaded 2026-10-20),
// as 128 px WebP: the plans people pay for look like the apps they already use.
const APP_ICONS = { chatgpt: chatGPTIcon, claude: claudeIcon } as const;

/** A plan's app icon, rounded like on a phone (22%). */
export function AppIcon({ app, size = 40 }: { app: keyof typeof APP_ICONS; size?: number }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className="provider-icon"
      draggable={false}
      height={size}
      src={APP_ICONS[app]}
      style={{
        flexShrink: 0,
        borderRadius: size * 0.22,
        boxShadow: "0 0 0 0.5px rgb(0 0 0 / 10%)",
      }}
      width={size}
    />
  );
}

/** Whether ProviderIcon has artwork for this provider id. */
export const hasProviderIcon = (id: string) =>
  id === "openai-codex" || id === "claude-code" || isTileProvider(id);

/** A provider's square icon by its server id: the app icon for a plan, otherwise its tile. */
export function ProviderIcon({ id, size = 40 }: { id: string; size?: number }) {
  if (id === "openai-codex") return <AppIcon app="chatgpt" size={size} />;
  if (id === "claude-code") return <AppIcon app="claude" size={size} />;
  if (isTileProvider(id)) return <ProviderTile provider={id} size={size} />;
  return null;
}
