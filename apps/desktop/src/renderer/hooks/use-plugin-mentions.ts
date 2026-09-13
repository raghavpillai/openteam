import { useEffect, useState } from "react";
import type { MentionOption } from "@openteam/product-core/mentions";
import { api } from "../client/openteam-api";

export function usePluginMentions(botId?: string): MentionOption[] {
  const [items, setItems] = useState<MentionOption[]>([]);
  useEffect(() => {
    let active = true;
    setItems([]);
    if (!botId) return;
    const refresh = () => { void api.pluginComposer(botId).then((result) => { if (active) setItems(result.items); }).catch(() => { if (active) setItems([]); }); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("openteam:plugins-changed", refresh);
    const timer = setInterval(refresh, 30_000);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("openteam:plugins-changed", refresh); };
  }, [botId]);
  return items;
}
