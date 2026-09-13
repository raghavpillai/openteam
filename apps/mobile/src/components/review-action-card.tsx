import type { ChannelMessageView } from "@openteam/contracts";
import { useRef, useState } from "react";
import { Pressable, Share, Text, View } from "react-native";
import { useOpenTeam } from "../state/openteam-context";
import { useTheme } from "../theme";
export function MobileReviewActionCard({
  message,
  readOnly,
}: {
  message: ChannelMessageView;
  readOnly?: boolean;
}) {
  const inFlight = useRef(false);
  const api = useOpenTeam();
  const theme = useTheme();
  const metadata = message.metadata as Record<string, unknown>;
  const review = metadata.review as Record<string, any>;
  const state = String(metadata.cardState ?? "pending");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(false),
    [imported, setImported] = useState(false);
  const [importId] = useState(
    () => `template-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const act = async (action: "approve" | "cancel" | "refresh" | "import" | "unpublish") => {
    if (inFlight.current || readOnly) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.mutateReviewAction(message.id, action, importId);
      if (result?.botId) setImported(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The review could not be completed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const text = { color: theme.text };
  const template = review.kind === "template";
  const button = (
    label: string,
    action: "approve" | "cancel" | "refresh" | "import" | "unpublish"
  ) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy || readOnly}
      onPress={() => void act(action)}
      style={{ padding: 10, opacity: busy || readOnly ? 0.4 : 1 }}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={{ backgroundColor: theme.assistantBubble, padding: 14, borderRadius: 16, gap: 12 }}
    >
      <Text style={[text, { fontWeight: "600", fontSize: 17 }]}>
        {template
          ? `${review.recipe.profile.name} · version ${review.version}`
          : "Review product feedback"}
      </Text>
      {template ? (
        <>
          <Text style={text}>{review.recipe.profile.description}</Text>
          <Text style={text}>
            Visibility:{" "}
            {review.recipe.visibility === "public"
              ? "Public after publishing"
              : "This OpenTeam installation"}
          </Text>
          <Pressable onPress={() => setExpanded(!expanded)}>
            <Text style={text}>{expanded ? "Hide" : "Review"} complete template</Text>
          </Pressable>
          {expanded && (
            <Text selectable style={[text, { fontSize: 12 }]}>
              {JSON.stringify(review.recipe, null, 2)}
            </Text>
          )}
          <Pressable
            onPress={() =>
              void Share.share({
                message: JSON.stringify(review.recipe, null, 2),
                title: "Bot template",
              }).catch(() => setError("Sharing was unavailable"))
            }
          >
            <Text style={text}>Export template JSON</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={text}>{review.message}</Text>
          <Text style={text}>To: {review.destination}</Text>
          <Text style={text}>
            {review.wantsResponse ? "Request a reply from support" : "No reply requested"}
          </Text>
        </>
      )}
      {state === "pending" ? (
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          {button("Cancel", "cancel")}
          {button(
            busy ? "Working…" : template ? "Publish this version" : "Send feedback",
            "approve"
          )}
        </View>
      ) : (
        <>
          <Text style={text}>{String(metadata.outcomeText ?? state)}</Text>
          {state === "sending" && button("Check delivery", "refresh")}
          {template && state === "unpublished" && button("Publish this version again", "approve")}
          {template && state === "published" && button("Unpublish", "unpublish")}
          {template &&
            state === "published" &&
            (imported ? (
              <Text style={text}>Bot created — open it from your bot list</Text>
            ) : (
              button("Create a bot from this template", "import")
            ))}
        </>
      )}
      {!!error && <Text style={{ color: "#dc2626" }}>{error}</Text>}
    </View>
  );
}
