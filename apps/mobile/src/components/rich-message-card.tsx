import { PermissionIcon } from "./permission-icon";
import { MobileReviewActionCard } from "./review-action-card";
import { parseExternalDraft } from "@openteam/contracts/external-draft";
import { MobileExternalDraftCard } from "./external-draft-card";
import * as Haptics from "../haptics";
import type {
  ChannelMessageView,
  RichMessageComputerHandoff,
  RichMessageWidget,
} from "@openteam/contracts";
import {
  widgetOptionValue as optionValue,
  projectRichMessage,
  richMessageMetadata as record,
  resolvedWidgetAnswers,
  createWidgetDraftStore,
  secretRequestPlaceholder,
  toggleWidgetSelection,
  widgetOptionLetter,
  widgetResponseValue,
} from "@openteam/product-core/rich-messages";
import { SymbolView } from "expo-symbols";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useOpenTeam } from "../state/openteam-context";
import { usePermissionTheme as useTheme } from "./permission-theme";
import { BotMark } from "./bot-mark";
import { parseUserForm } from "@openteam/contracts/review-cards";
import { MobileUserFormCard } from "./user-form-card";

const actionFailed = (message: string) => {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  Alert.alert("Couldn’t complete the action", message);
};

const widgetDrafts = createWidgetDraftStore();

export function MobileRichMessageCard({
  message,
  onWidgetResponse,
  onWidgetDismiss,
  onSecretSubmit,
  onComputerHandoff,
  onCloudAgentOpen,
  onCloudAgentPublish,
  readOnly = false,
}: {
  message: ChannelMessageView;
  onWidgetResponse: (value: string) => Promise<boolean>;
  onWidgetDismiss: () => Promise<boolean>;
  onSecretSubmit: (value: string) => Promise<boolean>;
  onComputerHandoff: (action: "start" | "skip") => Promise<boolean>;
  onCloudAgentOpen?: () => void;
  onCloudAgentPublish?: () => void;
  readOnly?: boolean;
}) {
  const theme = useTheme();
  const { connection } = useOpenTeam();
  const projection = projectRichMessage(message);
  const metadata = projection?.metadata ?? record(message.metadata);
  const [local, setLocal] = useState(metadata);
  const widgetFlight = useRef(false);
  const [widgetError, setWidgetError] = useState("");
  const authoritative = useRef(metadata);
  authoritative.current = metadata;
  useEffect(() => setLocal(record(message.metadata)), [message.metadata]);
  const draftKey = JSON.stringify([connection?.serverUrl ?? "", message.id, metadata.widget]);
  useEffect(() => {
    if (
      !widgetFlight.current &&
      (local.widgetDismissed === true || typeof local.respondedValue === "string")
    )
      widgetDrafts.clear(draftKey);
  }, [draftKey, local]);
  const cardStyle = [styles.card, { backgroundColor: theme.assistantBubble }];
  if (metadata.type === "review-action" && metadata.review && typeof metadata.review === "object")
    return <MobileReviewActionCard message={message} readOnly={readOnly} />;
  if (metadata.type === "external-draft") {
    try {
      return (
        <MobileExternalDraftCard
          draft={parseExternalDraft(metadata.draft)}
          message={message}
          readOnly={readOnly}
        />
      );
    } catch {
      return null;
    }
  }
  if (metadata.type === "user-form") {
    try {
      return (
        <MobileUserFormCard
          form={parseUserForm(metadata.form)}
          message={message}
          readOnly={readOnly}
        />
      );
    } catch {
      return null;
    }
  }

  if (projection?.kind === "cloud-agent") {
    return (
      <CloudAgentCard
        agent={projection.agent}
        onOpen={onCloudAgentOpen}
        onPublish={onCloudAgentPublish}
        readOnly={readOnly}
      />
    );
  }

  if (projection?.kind === "secret-request") {
    const request = projection.request;
    return (
      <SecretCard
        description={typeof request.description === "string" ? request.description : undefined}
        label={request.label}
        name={typeof request.name === "string" ? request.name : undefined}
        scope={request.scope === "personal" ? "personal" : "bot"}
        onSubmit={async (value) => {
          const accepted = await onSecretSubmit(value);
          if (accepted) setLocal((current) => ({ ...current, secretProvided: true }));
          return accepted;
        }}
        provided={local.secretProvided === true}
        readOnly={readOnly}
      />
    );
  }

  if (projection?.kind === "computer-handoff") {
    return (
      <ComputerHandoffCard
        botId={message.senderBotId}
        handoff={projection.handoff}
        messageId={message.id}
        onMutate={onComputerHandoff}
        readOnly={readOnly}
        state={
          typeof local.computerHandoffState === "string"
            ? local.computerHandoffState
            : projection.state
        }
      />
    );
  }

  if (projection?.kind !== "widget") return null;
  const widget = projection.widget;
  if (local.widgetDismissed === true) {
    return (
      <View
        accessibilityLabel="Dismissed question"
        style={[cardStyle, { flexDirection: "row", alignItems: "flex-start", gap: 8 }]}
      >
        <Text style={[styles.title, { color: theme.textMuted }]}>{widget.prompt}</Text>
        <View style={[styles.dismissedPill, { backgroundColor: theme.surfacePressed }]}>
          <View style={[styles.dismissedDot, { backgroundColor: theme.textMuted }]} />
          <Text style={[styles.dismissed, { color: theme.textMuted }]}>Dismissed</Text>
        </View>
      </View>
    );
  }
  if (typeof local.respondedValue === "string") {
    const answers = resolvedWidgetAnswers(widget, local.respondedValue);
    return (
      <View accessibilityLabel="Answered question" style={cardStyle}>
        <Text style={[styles.title, { color: theme.text }]}>{widget.prompt}</Text>
        <View
          accessibilityLabel="Your answer"
          style={[
            styles.optionGroup,
            {
              backgroundColor: theme.surfacePressed,
              borderColor: theme.separator,
            },
          ]}
        >
          {answers.map((answer, index) => (
            <View
              key={answer.value}
              style={[
                styles.option,
                { padding: 9 },
                index > 0 && {
                  borderTopColor: theme.separator,
                  borderTopWidth: 0.5,
                },
              ]}
            >
              {answer.optionIndex !== null && (
                <View
                  style={[
                    styles.key,
                    {
                      opacity: 0.4,
                      backgroundColor: theme.surfacePressed,
                      borderColor: theme.separator,
                    },
                  ]}
                >
                  <Text style={[styles.keyText, { color: theme.textMuted }]}>
                    {widgetOptionLetter(answer.optionIndex)}
                  </Text>
                </View>
              )}
              <Text style={[styles.optionLabel, { color: theme.textMuted }]}>{answer.label}</Text>
              <PermissionIcon name="check" size={14} tintColor={theme.textMuted} />
            </View>
          ))}
        </View>
      </View>
    );
  }
  const answerWidget = async (value?: string) => {
    if (widgetFlight.current || readOnly) return false;
    const previous = authoritative.current;
    widgetFlight.current = true;
    setWidgetError("");
    setLocal({
      ...previous,
      ...(value === undefined ? { widgetDismissed: true } : { respondedValue: value }),
    });
    try {
      const accepted =
        value === undefined ? await onWidgetDismiss() : await onWidgetResponse(value);
      if (!accepted && authoritative.current === previous) {
        setLocal(previous);
        setWidgetError(
          "We couldn't confirm your answer. Check the card in a moment before trying again."
        );
      }
      if (accepted) widgetDrafts.clear(draftKey);
      return accepted;
    } catch {
      if (authoritative.current === previous) {
        setLocal(previous);
        setWidgetError(
          "We couldn't confirm your answer. Check the card in a moment before trying again."
        );
      }
      return false;
    } finally {
      widgetFlight.current = false;
    }
  };
  return (
    <WidgetCard
      draftKey={draftKey}
      initialError={widgetError}
      readOnly={readOnly}
      onDismiss={() => answerWidget()}
      onSubmit={answerWidget}
      widget={widget}
    />
  );
}

function ComputerHandoffCard({
  botId,
  handoff,
  messageId,
  onMutate,
  readOnly,
  state,
}: {
  botId: string | null;
  handoff: RichMessageComputerHandoff;
  messageId: string;
  onMutate: (action: "start" | "skip") => Promise<boolean>;
  readOnly: boolean;
  state: string;
}) {
  const theme = useTheme();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [localState, setLocalState] = useState(state);
  useEffect(() => setLocalState(state), [state]);
  const terminal = ["completed", "skipped", "dismissed"].includes(localState);
  const mutate = async (action: "start" | "skip") => {
    if (inFlight.current || readOnly || terminal || (action === "start" && !botId)) return;
    inFlight.current = true;
    setPending(true);
    try {
      const accepted = await onMutate(action);
      if (!accepted) {
        actionFailed("The computer request could not be updated. Please try again.");
        return;
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setLocalState(action === "start" ? "active" : "skipped");
      if (action === "start" && botId) {
        router.push({
          pathname: "/computer/[botId]",
          params: { botId, handoffId: messageId },
        });
      }
    } catch {
      actionFailed("The computer request could not be updated. Please try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <View
      accessibilityLabel="Take over the computer"
      style={[styles.card, { backgroundColor: theme.assistantBubble }]}
    >
      <View style={styles.headingRow}>
        <SymbolView
          name="rectangle.inset.filled.and.person.filled"
          size={18}
          tintColor={theme.text}
        />
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: theme.text }]}>Take over the computer</Text>
          <Text style={[styles.help, { color: theme.textMuted }]}>{handoff.reason}</Text>
        </View>
      </View>
      {terminal ? (
        <Text style={[styles.dismissedStatus, { color: theme.textMuted }]}>{localState}</Text>
      ) : (
        <View style={styles.handoffActions}>
          <Pressable
            accessibilityRole="button"
            disabled={pending || readOnly}
            onPress={() => void mutate("skip")}
            style={({ pressed }) => [styles.handoffSecondary, pressed && { opacity: 0.65 }]}
          >
            <Text style={[styles.submitText, { color: theme.textMuted }]}>Skip</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={pending || readOnly || !botId}
            onPress={() => void mutate("start")}
            style={[styles.submit, { backgroundColor: theme.text }]}
          >
            <Text style={[styles.submitText, { color: theme.background }]}>
              {localState === "active" ? "Return to computer" : "Take over"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function CloudAgentCard({
  agent,
  onOpen,
  onPublish,
  readOnly,
}: {
  agent: {
    color: string;
    description?: string;
    icon?: string;
    name: string;
    status: "draft" | "published";
  };
  onOpen?: () => void;
  onPublish?: () => void;
  readOnly: boolean;
}) {
  const theme = useTheme();
  const published = agent.status === "published";
  return (
    <View
      accessibilityLabel={`${agent.name}, ${published ? "Published" : "Unpublished"}`}
      style={[styles.card, styles.cloudAgentCard, { backgroundColor: theme.assistantBubble }]}
    >
      <View style={styles.cloudAgentHeading}>
        <Text numberOfLines={1} style={[styles.cloudAgentName, { color: theme.text }]}>
          {agent.name}
        </Text>
        <View style={[styles.cloudAgentStatus, { backgroundColor: theme.surfacePressed }]}>
          <View style={[styles.cloudAgentStatusDot, { backgroundColor: theme.textMuted }]} />
          <Text style={[styles.cloudAgentStatusText, { color: theme.textMuted }]}>
            {published ? "Published" : "Unpublished"}
          </Text>
        </View>
      </View>
      <View style={styles.cloudAgentPreview}>
        <View style={styles.cloudAgentGlowLarge} />
        <View style={styles.cloudAgentGlowSmall} />
        <BotMark color={agent.color} icon={agent.icon} size={58} />
      </View>
      <Text numberOfLines={3} style={[styles.cloudAgentDescription, { color: theme.textMuted }]}>
        {agent.description || "A reusable Bot template."}
      </Text>
      <View style={styles.cloudAgentActions}>
        {!published ? (
          <Pressable
            accessibilityRole="button"
            disabled={readOnly || !onPublish}
            onPress={onPublish}
            style={({ pressed }) => [
              styles.cloudAgentPrimaryAction,
              { backgroundColor: theme.text },
              pressed && styles.cloudAgentPressed,
            ]}
          >
            <Text style={[styles.cloudAgentPrimaryLabel, { color: theme.background }]}>
              Publish
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={readOnly || !onOpen}
          onPress={onOpen}
          style={({ pressed }) => [
            styles.cloudAgentSecondaryAction,
            { backgroundColor: theme.surfacePressed },
            pressed && styles.cloudAgentPressed,
          ]}
        >
          <Text style={[styles.cloudAgentSecondaryLabel, { color: theme.text }]}>View details</Text>
        </Pressable>
      </View>
    </View>
  );
}

function WidgetCard({
  draftKey,
  initialError,
  widget,
  onSubmit,
  onDismiss,
  readOnly,
}: {
  draftKey: string;
  initialError?: string;
  widget: RichMessageWidget;
  onSubmit: (value: string) => Promise<boolean>;
  onDismiss: () => Promise<boolean>;
  readOnly: boolean;
}) {
  const theme = useTheme();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(widgetDrafts.read(draftKey).selected)
  );
  const [custom, setCustom] = useState(() => widgetDrafts.read(draftKey).custom);
  useEffect(() => {
    if (!readOnly) widgetDrafts.write(draftKey, custom, selected);
  }, [draftKey, readOnly, custom, selected]);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState(initialError ?? "");
  const answer = useMemo(
    () => widgetResponseValue(widget, selected, custom),
    [custom, selected, widget]
  );
  const mutate = async (value?: string) => {
    if (inFlight.current || readOnly || (value !== undefined && !value.trim())) return;
    inFlight.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPending(true);
    setError("");
    try {
      const accepted = value === undefined ? await onDismiss() : await onSubmit(value);
      if (!accepted)
        setError("We couldn't confirm your answer. Check this card before trying again.");
    } catch {
      setError("We couldn't confirm your answer. Check this card before trying again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const submit = (value: string) => mutate(value);
  return (
    <View
      accessibilityLabel={widget.prompt}
      style={[styles.card, { backgroundColor: theme.assistantBubble }]}
    >
      <View style={[styles.headingRow, styles.cardHeading]}>
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: theme.text }]}>{widget.prompt}</Text>
          {widget.helpText ? (
            <Text style={[styles.help, { color: theme.textMuted }]}>{widget.helpText}</Text>
          ) : null}
        </View>
        <Pressable
          accessibilityLabel="Dismiss question"
          accessibilityRole="button"
          disabled={pending || readOnly}
          hitSlop={8}
          onPress={() => void mutate()}
          style={styles.dismissButton}
        >
          <PermissionIcon name="close" size={12} tintColor={theme.textMuted} />
        </Pressable>
      </View>
      <View
        style={[
          styles.optionGroup,
          {
            backgroundColor: theme.options,
            borderColor: theme.separator,
          },
        ]}
      >
        {widget.options.map((option, index) => {
          const value = optionValue(option);
          const active = selected.has(value);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={widget.multiSelect ? { selected: active } : undefined}
              disabled={pending || readOnly}
              key={`${value}\u0000${option.label}\u0000${option.description ?? ""}\u0000${option.style ?? ""}`}
              onPress={() => {
                if (readOnly || inFlight.current) return;
                if (!widget.multiSelect) {
                  void submit(value);
                  return;
                }
                void Haptics.selectionAsync();
                setSelected((current) => new Set(toggleWidgetSelection(current, value)));
              }}
              style={({ pressed }) => [
                styles.option,
                { padding: 9 },
                index > 0 && {
                  borderTopColor: theme.separator,
                  borderTopWidth: 0.5,
                },
                (pressed || active) && {
                  backgroundColor: theme.selected,
                },
              ]}
            >
              <View
                style={[
                  styles.key,
                  {
                    backgroundColor: theme.selected,
                    borderColor: theme.dark ? "#fcfcfc0d" : "#1414140d",
                  },
                ]}
              >
                <Text style={[styles.keyText, { color: theme.textMuted }]}>
                  {widgetOptionLetter(index)}
                </Text>
              </View>
              <View style={styles.optionCopy}>
                <Text style={[styles.optionLabel, { color: theme.text }]}>{option.label}</Text>
                {option.description ? (
                  <Text style={[styles.help, { color: theme.textMuted }]}>
                    {option.description}
                  </Text>
                ) : null}
              </View>
              {active ? <PermissionIcon name="check" size={14} tintColor={theme.text} /> : null}
            </Pressable>
          );
        })}
      </View>
      {widget.allowCustom ? (
        <View style={styles.customRow}>
          <TextInput
            accessibilityLabel="Custom answer"
            autoCapitalize="sentences"
            autoComplete="off"
            editable={!pending && !readOnly}
            keyboardAppearance={theme.dark ? "dark" : "light"}
            multiline
            onChangeText={setCustom}
            onSubmitEditing={() => void submit(widget.multiSelect ? answer : custom.trim())}
            placeholder="Type your own answer"
            placeholderTextColor={theme.dark ? "#fcfcfc8f" : "#1414149c"}
            returnKeyType="send"
            secureTextEntry={false}
            spellCheck={false}
            style={[
              styles.input,
              {
                flex: 1,
                minWidth: 0,
                lineHeight: 20,
                backgroundColor: theme.field,
                borderColor: theme.border,
                color: theme.text,
              },
            ]}
            value={custom}
          />
          {custom.trim() && !widget.multiSelect ? (
            <Pressable
              accessibilityRole="button"
              disabled={pending || readOnly}
              onPress={() => void submit(custom.trim())}
              style={[styles.submit, { backgroundColor: theme.text }]}
            >
              <Text style={[styles.submitText, { color: theme.background }]}>Submit</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.danger }}>
          {error}
        </Text>
      ) : null}
      {widget.multiSelect && answer ? (
        <View style={styles.submitRow}>
          <Pressable
            accessibilityRole="button"
            disabled={pending || readOnly}
            onPress={() => void submit(answer)}
            style={[styles.submit, { backgroundColor: theme.text }]}
          >
            <Text style={[styles.submitText, { color: theme.background }]}>Submit</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function SecretCard({
  label,
  name,
  scope,
  description,
  provided,
  onSubmit,
  readOnly,
}: {
  label: string;
  name?: string;
  scope?: "personal" | "bot";
  description?: string;
  provided: boolean;
  onSubmit: (value: string) => Promise<boolean>;
  readOnly: boolean;
}) {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (provided) {
      setValue("");
      setError("");
    }
  }, [provided]);
  const botSecret = !!name && scope !== "personal";
  const variableNote = name ? (
    <Text style={{ color: theme.textMuted, fontSize: 14, lineHeight: 22, letterSpacing: -0.15 }}>
      Saved securely {botSecret ? "for all users of this bot" : "for you"} and exposed as {name}
    </Text>
  ) : null;
  return (
    <View
      accessibilityLabel={label}
      style={[styles.card, styles.secretCard, { backgroundColor: theme.assistantBubble }]}
    >
      {!provided && error ? (
        <Text accessibilityRole="alert" style={{ color: theme.danger }}>
          {error}
        </Text>
      ) : null}
      {provided ? (
        <View style={styles.savedCardRow}>
          <View style={styles.headingCopy}>
            <Text
              style={[styles.title, { color: theme.text, lineHeight: 22, letterSpacing: -0.15 }]}
            >
              {label}
            </Text>
            {variableNote}
            <Text style={[styles.help, { color: theme.textMuted }]}>
              {botSecret
                ? "Saved for all users of this bot. Configure in bot settings."
                : "Saved securely and kept private."}
            </Text>
          </View>
          <View style={[styles.savedRow, { backgroundColor: theme.successBackground }]}>
            <PermissionIcon name="check" size={12} tintColor={theme.success} />
            <Text
              style={{
                color: theme.success,
                fontSize: 14,
                lineHeight: 22,
                letterSpacing: -0.15,
                fontWeight: "500",
              }}
            >
              Saved
            </Text>
          </View>
        </View>
      ) : (
        <>
          <View>
            <Text
              style={[styles.title, { color: theme.text, lineHeight: 22, letterSpacing: -0.15 }]}
            >
              {label}
            </Text>
            {variableNote}
            {description ? (
              <Text style={[styles.help, { color: theme.textMuted }]}>{description}</Text>
            ) : null}
          </View>
          <View style={styles.secretRow}>
            <TextInput
              accessibilityLabel={label}
              autoCapitalize="none"
              autoComplete="off"
              editable={!pending && !readOnly}
              keyboardAppearance={theme.dark ? "dark" : "light"}
              onChangeText={setValue}
              placeholder={secretRequestPlaceholder(label)}
              placeholderTextColor={theme.textFaint}
              secureTextEntry
              spellCheck={false}
              style={[
                styles.input,
                styles.secretInput,
                {
                  backgroundColor: theme.field,
                  borderColor: theme.border,
                  color: theme.text,
                },
              ]}
              value={value}
            />
            <Pressable
              accessibilityRole="button"
              disabled={!value.trim() || pending || readOnly}
              onPress={async () => {
                const secret = value;
                if (!secret.trim() || inFlight.current || readOnly || provided) return;
                inFlight.current = true;
                setError("");
                setValue("");
                setPending(true);
                try {
                  const accepted = await onSubmit(secret);
                  if (accepted) {
                    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  } else {
                    setError("This value could not be saved. Enter it again to retry.");
                  }
                } catch {
                  // Keep the submitted value out of the rendered field after every attempt.
                  setError("This value could not be saved. Enter it again to retry.");
                } finally {
                  inFlight.current = false;
                  setPending(false);
                }
              }}
              style={[
                styles.submit,
                { backgroundColor: theme.text },
                (!value.trim() || pending || readOnly) && styles.disabled,
              ]}
            >
              <Text style={[styles.submitText, { color: theme.background }]}>Save securely</Text>
            </Pressable>
          </View>
          <View style={styles.securityRow}>
            <PermissionIcon name="shield" size={12} tintColor={theme.textMuted} />
            <Text style={[styles.securityText, { color: theme.textMuted }]}>
              Stored securely, never shown to your Bot.
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "100%",
    maxWidth: 520,
    alignSelf: "flex-start",
    borderRadius: 16,
    overflow: "hidden",
    padding: 12,
    gap: 10,
  },
  cardHeading: {},
  headingRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  headingCopy: { flex: 1 },
  title: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  help: { fontSize: 14, lineHeight: 20 },
  dismissedFullCard: {},
  dismissedOptions: { opacity: 0.48 },
  dismissedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  dismissedDot: { width: 6, height: 6, borderRadius: 999 },
  dismissed: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  dismissedStatus: { opacity: 0.48, fontSize: 13, lineHeight: 18 },
  dismissButton: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  optionGroup: {
    width: "100%",
    overflow: "hidden",
    borderRadius: 8,
    borderWidth: 1,
  },
  option: {
    padding: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  key: {
    width: 18,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 4,
    paddingVertical: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  keyText: { fontSize: 11, lineHeight: 16, letterSpacing: 0.055, fontWeight: "400" },
  optionCopy: { flex: 1 },
  optionLabel: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: "400" },
  customRow: { width: "100%", flexDirection: "row", alignItems: "flex-start", gap: 8 },
  input: {
    minHeight: 32,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 14,
  },
  submitRow: { alignItems: "flex-end" },
  submit: {
    minHeight: 32,
    borderRadius: 8,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  submitText: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  handoffActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  handoffSecondary: {
    minHeight: 32,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  secretCard: {},
  secretRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  secretInput: { flex: 1 },
  securityRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  securityText: { flex: 1, fontSize: 13, lineHeight: 18, letterSpacing: -0.08 },
  savedCardRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cloudAgentCard: { borderRadius: 20, padding: 10, gap: 10 },
  cloudAgentHeading: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cloudAgentName: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  cloudAgentStatus: {
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  cloudAgentStatusDot: { width: 6, height: 6, borderRadius: 3 },
  cloudAgentStatusText: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  cloudAgentPreview: {
    height: 148,
    borderRadius: 12,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#25163f",
  },
  cloudAgentGlowLarge: {
    position: "absolute",
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: "rgba(118,68,191,0.16)",
  },
  cloudAgentGlowSmall: {
    position: "absolute",
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: "rgba(139,83,224,0.18)",
  },
  cloudAgentDescription: { fontSize: 13, lineHeight: 17 },
  cloudAgentActions: { flexDirection: "row", alignItems: "center", gap: 7 },
  cloudAgentPrimaryAction: {
    minHeight: 34,
    borderRadius: 10,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  cloudAgentSecondaryAction: {
    minHeight: 34,
    borderRadius: 10,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  cloudAgentPrimaryLabel: { fontSize: 14, lineHeight: 18, fontWeight: "600" },
  cloudAgentSecondaryLabel: { fontSize: 14, lineHeight: 18, fontWeight: "600" },
  cloudAgentPressed: { opacity: 0.72 },
  disabled: { opacity: 0.36 },
});
