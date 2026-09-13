import { type ChannelMessageView } from "@openteam/contracts";
import { useEffect, useRef, useState } from "react";
import { api } from "../../client/openteam-api";
export function ReviewActionCard({ message }: { message: ChannelMessageView }) {
  const inFlight = useRef(false);
  const metadata = message.metadata as Record<string, unknown>;
  const review = metadata.review as Record<string, any>;
  const [state, setState] = useState(String(metadata.cardState ?? "pending"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imported, setImported] = useState(false);
  const [importId] = useState(() => crypto.randomUUID());
  useEffect(() => setState(String(metadata.cardState ?? "pending")), [metadata.cardState]);
  const act = async (action: "approve" | "cancel" | "refresh" | "import" | "unpublish") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.mutateReviewAction(message.id, action, importId);
      setState(String((result.message.metadata as Record<string, unknown>).cardState));
      if (result.botId) setImported(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The review could not be completed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const download = async () => {
    try {
      const recipe = await api.reviewRecipe(message.id);
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
  const template = review.kind === "template";
  return (
    <div className="rich-message-card flex w-full max-w-[560px] flex-col gap-3 rounded-2xl bg-[#eeeeee] p-4 text-sm dark:bg-[#262626]">
      <strong>
        {template
          ? `${review.recipe.profile.name} · version ${review.version}`
          : "Review product feedback"}
      </strong>
      {template ? (
        <>
          <p>{review.recipe.profile.description}</p>
          <p>
            Visibility:{" "}
            {review.recipe.visibility === "public"
              ? "Public after publishing"
              : "People with access to this OpenTeam installation"}
          </p>
          <details>
            <summary>Review complete template</summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-background p-3 text-xs">
              {JSON.stringify(review.recipe, null, 2)}
            </pre>
          </details>
          <button className="text-left underline" onClick={() => void download()}>
            Download template JSON
          </button>
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap">{review.message}</p>
          <p>To: {review.destination}</p>
          <p>{review.wantsResponse ? "Request a reply from support" : "No reply requested"}</p>
        </>
      )}
      {state === "pending" ? (
        <div className="flex justify-end gap-3">
          <button disabled={busy} onClick={() => void act("cancel")}>
            Cancel
          </button>
          <button
            className="rounded-lg bg-foreground px-3 py-2 text-background"
            disabled={busy}
            onClick={() => void act("approve")}
          >
            {busy ? "Working…" : template ? "Publish this version" : "Send feedback"}
          </button>
        </div>
      ) : (
        <>
          <p>
            {state === "published"
              ? "Published"
              : state === "sending"
                ? "Sending…"
                : String(metadata.outcomeText ?? state)}
          </p>
          {state === "sending" && (
            <button disabled={busy} onClick={() => void act("refresh")}>
              Check delivery
            </button>
          )}
          {template && state === "unpublished" && (
            <button disabled={busy} onClick={() => void act("approve")}>
              Publish this version again
            </button>
          )}
          {template && state === "published" && (
            <button disabled={busy} onClick={() => void act("unpublish")}>
              Unpublish
            </button>
          )}
          {template && state === "published" && (
            <button disabled={busy || imported} onClick={() => void act("import")}>
              {imported
                ? "Bot created — open it from the sidebar"
                : "Create a bot from this template"}
            </button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
