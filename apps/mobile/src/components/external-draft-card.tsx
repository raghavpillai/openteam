import type { ExternalDraft } from "@openteam/contracts/external-draft";
import { externalDraftReviewEdits } from "@openteam/client-core/external-draft";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import type { ChannelMessageView } from "@openteam/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useOpenTeam } from "../state/openteam-context";
import { useTheme } from "../theme";
export function MobileExternalDraftCard({
  message,
  draft,
  readOnly,
}: {
  message: ChannelMessageView;
  draft: ExternalDraft;
  readOnly?: boolean;
}) {
  const inFlight = useRef(false);
  const theme = useTheme();
  const api = useOpenTeam();
  const metadata = message.metadata as Record<string, unknown>;
  const [unconfirmed, setUnconfirmed] = useState(false);
  const state = unconfirmed ? "unconfirmed" : String(metadata.cardState ?? "pending");
  const [body, setBody] = useState(draft.body);
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [to, setTo] = useState(draft.to?.join(", ") ?? "");
  const [cc, setCc] = useState(draft.cc?.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (metadata.cardState && metadata.cardState !== "pending") setUnconfirmed(false);
    if (metadata.cardState === "sent") setError("");
  }, [metadata.cardState]);
  const act = async (action: "save" | "send" | "cancel" | "refresh") => {
    if (inFlight.current || readOnly) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const edits = externalDraftReviewEdits(draft, action, { body, subject, to, cc });
      if (!(await api.mutateExternalDraft(message.id, action, edits))) {
        throw new Error("Connection is not ready. Reconnect to check this draft.");
      }
      setUnconfirmed(false);
    } catch (error) {
      setError(clientErrorMessage(error, "The draft could not be updated"));
      if (action === "send") {
        setUnconfirmed(true);
        try {
          if (await api.mutateExternalDraft(message.id, "refresh")) setUnconfirmed(false);
        } catch {
          /* Reconcile before enabling another send. */
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const text = { color: theme.text };
  const field = (label: string, value: string, set: (value: string) => void, multiline = false) => (
    <View style={{ gap: 4 }}>
      <Text style={text}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={!busy && !readOnly}
        multiline={multiline}
        value={value}
        onChangeText={set}
        style={[
          text,
          {
            borderColor: theme.textMuted,
            borderWidth: 1,
            borderRadius: 8,
            padding: 10,
            minHeight: multiline ? 120 : 40,
          },
        ]}
      />
    </View>
  );
  const button = (label: string, action: "save" | "send" | "cancel" | "refresh") => (
    <Pressable
      accessibilityRole="button"
      disabled={busy || readOnly || (action === "send" && !body.trim())}
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
      <Text style={[text, { fontSize: 17, fontWeight: "600" }]}>
        Review {draft.platform === "email" ? "email" : "Slack message"}
      </Text>
      <Text style={text}>
        Account:{" "}
        {String(
          (metadata.draft as { verification?: { identity: string } })?.verification?.identity ??
            draft.from ??
            draft.providerIdentifier
        )}
      </Text>
      {draft.platform === "slack" && (
        <Text style={text}>
          To: {draft.target} ({draft.channelId}){draft.threadTs ? " · Thread reply" : ""}
        </Text>
      )}
      {draft.replyToMessageId && (
        <Text style={text}>Reply to message {draft.replyToMessageId}</Text>
      )}
      {state === "pending" ? (
        <>
          {draft.platform === "email" && (
            <>
              {field("To", to, setTo)}
              {field("Cc", cc, setCc)}
              {field("Subject", subject, setSubject)}
            </>
          )}
          {field("Message body", body, setBody, true)}
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            {button("Cancel", "cancel")}
            {button("Save", "save")}
            {button(busy ? "Working…" : "Send", "send")}
          </View>
        </>
      ) : (
        <>
          <Text style={text}>
            {String(
              state === "unconfirmed"
                ? "Delivery needs checking. No automatic resend will occur."
                : state === "sent"
                  ? "Message sent"
                  : state === "dismissed"
                    ? "Draft cancelled"
                    : (metadata.outcomeText ?? (state === "sending" ? "Sending…" : state))
            )}
          </Text>
          {(state === "sending" || state === "unconfirmed") && button("Check delivery", "refresh")}
        </>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: theme.danger }}>
          {error}
        </Text>
      )}
    </View>
  );
}
