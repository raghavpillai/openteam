import type { ClientSnapshot } from "@openteam/contracts";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

export const MODEL_STATUS_TOAST_ID = "openteam-model-status";

type Problem = Exclude<ClientSnapshot["runtime"]["inference"], "ready">;

const NOTICES: Record<Problem, { title: string; description: string; action: string }> = {
  missing: {
    title: "No model connected",
    description: "Your bots can't reply until you connect a model.",
    action: "Connect a model",
  },
  invalid: {
    title: "Your model stopped working",
    description: "Your bots can't reply until you connect it again.",
    action: "Connect a model",
  },
  unavailable: {
    title: "Model service unavailable",
    description: "Your server can't reach its model service right now.",
    action: "Open settings",
  },
};

/**
 * Explains why bots are silent while the server has no working model. It steps aside while
 * Settings (whose Model page shows the same state) or the Marketplace is open, instead of
 * covering the dialog.
 */
export function ModelStatusBanner({
  inference,
  onOpenSettings,
  paused = false,
}: {
  inference: ClientSnapshot["runtime"]["inference"];
  onOpenSettings: () => void;
  paused?: boolean;
}) {
  const openSettings = useRef(onOpenSettings);
  openSettings.current = onOpenSettings;

  // Toasts outlive their React owner unless explicitly dismissed on sign-out.
  useEffect(
    () => () => {
      toast.dismiss(MODEL_STATUS_TOAST_ID);
    },
    []
  );

  useEffect(() => {
    if (inference === "ready" || paused) {
      toast.dismiss(MODEL_STATUS_TOAST_ID);
      return;
    }
    const notice = NOTICES[inference];
    toast.warning(notice.title, {
      id: MODEL_STATUS_TOAST_ID,
      description: notice.description,
      duration: Number.POSITIVE_INFINITY,
      action: { label: notice.action, onClick: () => openSettings.current() },
    });
  }, [inference, paused]);

  return null;
}
