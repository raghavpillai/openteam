import type { ChannelMessageView, RichMessageWidget } from "@openbot/contracts";
import {
  widgetOptionValue as optionValue,
  projectRichMessage,
  richMessageMetadata as record,
  resolvedWidgetAnswers,
  secretRequestPlaceholder,
  toggleWidgetSelection,
  widgetOptionLetter,
  widgetResponseValue,
} from "@openbot/product-core/rich-messages";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../theme";

export function MobileRichMessageCard({
  message,
  onWidgetResponse,
  onWidgetDismiss,
  onSecretSubmit,
  readOnly = false,
}: {
  message: ChannelMessageView;
  onWidgetResponse: (value: string) => Promise<boolean>;
  onWidgetDismiss: () => Promise<boolean>;
  onSecretSubmit: (value: string) => Promise<boolean>;
  readOnly?: boolean;
}) {
  const theme = useTheme();
  const projection = projectRichMessage(message);
  const metadata = projection?.metadata ?? record(message.metadata);
  const [local, setLocal] = useState(metadata);
  useEffect(() => setLocal(record(message.metadata)), [message.metadata]);
  const cardStyle = [styles.card, { backgroundColor: theme.assistantBubble }];

  if (projection?.kind === "secret-request") {
    const request = projection.request;
    return (
      <SecretCard
        description={typeof request.description === "string" ? request.description : undefined}
        label={request.label}
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

  if (projection?.kind !== "widget") return null;
  const widget = projection.widget;
  if (local.widgetDismissed === true) {
    return (
      <View accessibilityLabel="Dismissed question" style={[cardStyle, styles.dismissedFullCard]}>
        <View style={[styles.headingRow, styles.cardHeading]}>
          <View style={styles.headingCopy}>
            <Text style={[styles.title, { color: theme.text }]}>{widget.prompt}</Text>
            {widget.helpText ? (
              <Text style={[styles.help, { color: theme.textMuted }]}>{widget.helpText}</Text>
            ) : null}
          </View>
        </View>
        <View
          style={[
            styles.optionGroup,
            { backgroundColor: theme.surfacePressed, borderColor: theme.separator },
          ]}
        >
          {widget.options.map((option, index) => (
            <View
              key={`${optionValue(option)}:${option.label}`}
              style={[
                styles.option,
                index > 0 && {
                  borderTopColor: theme.separator,
                  borderTopWidth: StyleSheet.hairlineWidth,
                },
              ]}
            >
              <View
                style={[
                  styles.key,
                  { backgroundColor: theme.surfacePressed, borderColor: theme.separator },
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
            </View>
          ))}
        </View>
        <Text style={[styles.dismissedStatus, { color: theme.textMuted }]}>dismissed</Text>
      </View>
    );
  }
  if (typeof local.respondedValue === "string") {
    const answers = resolvedWidgetAnswers(widget, local.respondedValue);
    return (
      <View accessibilityLabel="Answered question" style={cardStyle}>
        <Text style={[styles.title, { color: theme.text }]}>{widget.prompt}</Text>
        {widget.helpText ? (
          <Text style={[styles.help, { color: theme.textMuted }]}>{widget.helpText}</Text>
        ) : null}
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
                index > 0 && {
                  borderTopColor: theme.separator,
                  borderTopWidth: StyleSheet.hairlineWidth,
                },
              ]}
            >
              <Text style={[styles.optionLabel, { color: theme.text }]}>{answer.label}</Text>
              <SymbolView name="checkmark" size={15} tintColor={theme.success} />
            </View>
          ))}
        </View>
      </View>
    );
  }
  return (
    <WidgetCard
      readOnly={readOnly}
      onDismiss={async () => {
        const previous = local;
        setLocal({ ...previous, widgetDismissed: true });
        try {
          const accepted = await onWidgetDismiss();
          if (!accepted) setLocal(previous);
        } catch {
          setLocal(previous);
        }
      }}
      onSubmit={async (value) => {
        const previous = local;
        setLocal({ ...previous, respondedValue: value });
        try {
          const accepted = await onWidgetResponse(value);
          if (!accepted) setLocal(previous);
        } catch {
          setLocal(previous);
        }
      }}
      widget={widget}
    />
  );
}

function WidgetCard({
  widget,
  onSubmit,
  onDismiss,
  readOnly,
}: {
  widget: RichMessageWidget;
  onSubmit: (value: string) => Promise<void>;
  onDismiss: () => Promise<void>;
  readOnly: boolean;
}) {
  const theme = useTheme();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [custom, setCustom] = useState("");
  const [pending, setPending] = useState(false);
  const answer = useMemo(
    () => widgetResponseValue(widget, selected, custom),
    [custom, selected, widget]
  );
  const submit = async (value: string) => {
    if (!value || pending || readOnly) return;
    setPending(true);
    try {
      await onSubmit(value);
    } finally {
      setPending(false);
    }
  };
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
          onPress={() => void onDismiss()}
          style={styles.dismissButton}
        >
          <SymbolView name="xmark" size={13} tintColor={theme.textMuted} />
        </Pressable>
      </View>
      <View
        style={[
          styles.optionGroup,
          {
            backgroundColor: theme.surfacePressed,
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
                if (readOnly) return;
                if (!widget.multiSelect) {
                  void submit(value);
                  return;
                }
                setSelected((current) => new Set(toggleWidgetSelection(current, value)));
              }}
              style={({ pressed }) => [
                styles.option,
                index > 0 && {
                  borderTopColor: theme.separator,
                  borderTopWidth: StyleSheet.hairlineWidth,
                },
                (pressed || active) && {
                  backgroundColor: theme.surfacePressed,
                },
              ]}
            >
              <View
                style={[
                  styles.key,
                  {
                    backgroundColor: theme.surfacePressed,
                    borderColor: theme.separator,
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
              {active ? <SymbolView name="checkmark" size={15} tintColor={theme.text} /> : null}
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
            multiline
            onChangeText={setCustom}
            onSubmitEditing={() => void submit(widget.multiSelect ? answer : custom.trim())}
            placeholder="Type your own answer"
            placeholderTextColor={theme.textFaint}
            returnKeyType="send"
            secureTextEntry={false}
            spellCheck={false}
            style={[
              styles.input,
              {
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
  description,
  provided,
  onSubmit,
  readOnly,
}: {
  label: string;
  description?: string;
  provided: boolean;
  onSubmit: (value: string) => Promise<boolean>;
  readOnly: boolean;
}) {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <View
      accessibilityLabel={label}
      style={[styles.card, styles.secretCard, { backgroundColor: theme.assistantBubble }]}
    >
      {provided ? (
        <View style={styles.savedCardRow}>
          <View style={styles.headingCopy}>
            <Text style={[styles.title, { color: theme.text }]}>{label}</Text>
            <Text style={[styles.help, { color: theme.textMuted }]}>
              Saved securely and kept private.
            </Text>
          </View>
          <View style={[styles.savedRow, { backgroundColor: theme.surfacePressed }]}>
            <SymbolView name="checkmark" size={15} tintColor={theme.success} />
            <Text style={[styles.optionLabel, { color: theme.success }]}>Saved</Text>
          </View>
        </View>
      ) : (
        <>
          <Text style={[styles.title, { color: theme.text }]}>{label}</Text>
          {description ? (
            <Text style={[styles.help, { color: theme.textMuted }]}>{description}</Text>
          ) : null}
          <View style={styles.secretRow}>
            <TextInput
              autoCapitalize="none"
              autoComplete="off"
              editable={!pending && !readOnly}
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
                if (!secret.trim() || pending || readOnly) return;
                setValue("");
                setPending(true);
                try {
                  await onSubmit(secret);
                } catch {
                  // The field remains empty so a submitted secret never lingers in memory.
                } finally {
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
            <SymbolView name="checkmark.shield" size={15} tintColor={theme.textMuted} />
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
  title: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  help: { fontSize: 13, lineHeight: 18 },
  dismissedFullCard: { opacity: 0.48 },
  dismissedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  dismissedDot: { width: 6, height: 6, borderRadius: 999 },
  dismissed: { fontSize: 12, fontWeight: "600" },
  dismissedStatus: { fontSize: 13, lineHeight: 18 },
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
    borderWidth: StyleSheet.hairlineWidth,
  },
  option: {
    padding: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  key: {
    minWidth: 18,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
    paddingVertical: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  keyText: { fontSize: 11, fontWeight: "600" },
  optionCopy: { flex: 1 },
  optionLabel: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: "600" },
  customRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  input: {
    minHeight: 32,
    borderWidth: StyleSheet.hairlineWidth,
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
  submitText: { fontSize: 14, fontWeight: "600" },
  secretCard: {},
  secretRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  secretInput: { flex: 1 },
  securityRow: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  securityText: { flex: 1, fontSize: 12, lineHeight: 17 },
  savedCardRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  disabled: { opacity: 0.36 },
});
