import { useEffect, useState } from "react";
import { AppState } from "react-native";
import type { MentionOption } from "@openteam/product-core/mentions";
import { useOpenTeam } from "../state/openteam-context";

export function usePluginMentions(botId?: string): MentionOption[] {
  const { pluginOperation } = useOpenTeam();
  const [items, setItems] = useState<MentionOption[]>([]);
  useEffect(() => {
    let active = true; setItems([]); if (!botId) return;
    const refresh = () => { void pluginOperation((client) => client.pluginComposer(botId)).then((result) => { if (active) setItems(result.items); }).catch(() => { if (active) setItems([]); }); };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    const timer = setInterval(refresh, 15_000);
    return () => { active = false; subscription.remove(); clearInterval(timer); };
  }, [botId, pluginOperation]);
  return items;
}
