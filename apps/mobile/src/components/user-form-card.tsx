import { PermissionSelect } from "./permission-select";
import { PermissionIcon } from "./permission-icon";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { userFormOutcome } from "@openteam/product-core/rich-messages";
import {
  formFieldIsSecret,
  validateUserFormValues,
  type UserForm,
} from "@openteam/contracts/review-cards";
import type { ChannelMessageView } from "@openteam/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { useOpenTeam } from "../state/openteam-context";
import { usePermissionTheme as useTheme } from "./permission-theme";

export function MobileUserFormCard({
  message,
  form,
  readOnly,
}: {
  message: ChannelMessageView;
  form: UserForm;
  readOnly?: boolean;
}) {
  const inFlight = useRef(false);
  const theme = useTheme();
  const api = useOpenTeam();
  const [values, setValues] = useState<Record<string, string | boolean>>({});

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const metadata = message.metadata as Record<string, unknown>;
  const state = String(metadata.cardState ?? "pending");
  const outcome = userFormOutcome(form, metadata);
  const authoritative = useRef(metadata);
  authoritative.current = metadata;
  useEffect(() => {
    if (state !== "pending") {
      setValues({});
      setError("");
    }
  }, [state]);
  useEffect(() => {
    let active = true;
    if (state === "pending" && !readOnly)
      void api
        .userFormPrefill(message.id)
        .then((prefill) => {
          if (active) setValues((current) => ({ ...prefill, ...current }));
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [message.id, state, readOnly, api.userFormPrefill]);
  const set = (id: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [id]: value }));
  let valid = true;
  try {
    validateUserFormValues(form, values);
  } catch {
    valid = false;
  }
  const submit = async (mode: "submit" | "dismissed" | "escalated" = "submit") => {
    const dismiss = mode !== "submit";
    if (inFlight.current || readOnly || state !== "pending" || (!dismiss && !valid)) return;
    const previous = authoritative.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const accepted = dismiss
        ? await api.dismissUserForm(message.id, mode as "dismissed" | "escalated")
        : await api.submitUserForm(message.id, values);
      if (accepted) {
        setValues({});
        if (mode === "escalated" && message.senderBotId)
          router.push({ pathname: "/computer/[botId]", params: { botId: message.senderBotId } });
      } else if (authoritative.current === previous)
        setError("We couldn't confirm the form was completed. Check the page before trying again.");
    } catch {
      if (authoritative.current === previous)
        setError("We couldn't confirm the form was completed. Check the page before trying again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const text = { color: theme.text, fontSize: 14, lineHeight: 22, letterSpacing: -0.15 };
  const button = (label: string, onPress: () => void, disabled = false, primary = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy || readOnly}
      onPress={onPress}
      style={{
        height: 32,
        paddingHorizontal: 10,
        justifyContent: "center",
        borderWidth: 1,
        borderColor: "transparent",
        backgroundColor: primary
          ? theme.text
          : label === "Dismiss"
            ? "transparent"
            : theme.surfacePressed,
        borderRadius: 8,
        opacity: disabled || busy || readOnly ? 0.56 : 1,
      }}
    >
      <Text
        style={[
          text,
          {
            letterSpacing: 0,
            color: primary ? theme.background : label === "Dismiss" ? theme.textMuted : theme.text,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
  const receipt = metadata.formReceipt as Record<string, unknown> | undefined;
  const failed =
    (receipt?.submitAttempted === true && receipt?.submitSucceeded !== true) ||
    state === "fill_failed" ||
    receipt?.interrupted === true ||
    !!receipt?.domainMismatch ||
    !!receipt?.pageMoved ||
    outcome.fields.some((field) =>
      ["Held for recovery", "Discarded", "Check the page"].includes(field.status)
    );
  const status = busy ? "sending" : failed ? "fill_failed" : state;
  const summary =
    status === "sending"
      ? "Sending…"
      : status === "submitted"
        ? form.domain
          ? "Filled into the page. Secret values were never shown to your Bot."
          : "Form submitted. Secret values were never shown to your Bot."
        : status === "fill_failed"
          ? "Could not fill into the page — it may have moved or changed. Secret values were never shown to your Bot."
          : status === "escalated"
            ? "You chose to do this step on the screen instead."
            : status === "expired"
              ? outcome.summary
              : "Dismissed without filling anything.";
  const badge =
    status === "sending"
      ? "Sending"
      : status === "submitted"
        ? "Submitted"
        : status === "fill_failed"
          ? "Not filled"
          : status === "escalated"
            ? "On screen"
            : "Dismissed";
  if (status !== "pending")
    return (
      <View
        style={{
          backgroundColor: theme.assistantBubble,
          padding: 12,
          borderRadius: 16,
          gap: 8,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[text, { fontWeight: "500" }]}>{form.title}</Text>
          <Text accessibilityRole="summary" style={[text, { color: theme.textMuted }]}>
            {summary}
          </Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 999,
            backgroundColor: theme.selected,
          }}
        >
          {status === "sending" && <ActivityIndicator size={12} color={theme.textMuted} />}
          {status === "submitted" && (
            <PermissionIcon name="check" size={12} tintColor={theme.textMuted} />
          )}
          <Text style={[text, { color: theme.textMuted, fontWeight: "500" }]}>{badge}</Text>
        </View>
      </View>
    );
  return (
    <View
      style={{ backgroundColor: theme.assistantBubble, padding: 12, borderRadius: 16, gap: 10 }}
    >
      <Text style={[text, { fontSize: 14, lineHeight: 22, fontWeight: "500" }]}>{form.title}</Text>
      <>
        <Text style={[text, { color: theme.textMuted, marginTop: -10 }]}>{form.instruction}</Text>
        {form.fields.map((field) => (
          <View key={field.id} style={{ gap: 4 }}>
            <Text
              style={{ color: theme.textMuted, fontSize: 13, lineHeight: 18, letterSpacing: -0.08 }}
            >
              {field.label}
              {field.required ? " *" : ""}
            </Text>
            {field.type === "checkbox" ? (
              <Pressable
                accessibilityRole="checkbox"
                aria-checked={values[field.id] === true}
                accessibilityLabel={field.label}
                accessibilityState={{
                  checked: values[field.id] === true,
                  disabled: busy || readOnly,
                }}
                disabled={busy || readOnly}
                onPress={() => set(field.id, values[field.id] !== true)}
                style={{ minHeight: 18, flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <View
                  style={{
                    width: 13,
                    height: 13,
                    borderWidth: 1,
                    borderColor: theme.border,
                    borderRadius: 2,
                    backgroundColor: values[field.id] === true ? theme.text : theme.field,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {values[field.id] === true && (
                    <PermissionIcon name="check" size={11} tintColor={theme.field} />
                  )}
                </View>
                <Text style={{ ...text, fontSize: 13, lineHeight: 18, letterSpacing: 0 }}>Yes</Text>
              </Pressable>
            ) : field.type === "select" ? (
              <PermissionSelect
                label={field.label}
                value={String(values[field.id] ?? "")}
                options={field.options ?? []}
                disabled={busy || readOnly}
                onChange={(value) => set(field.id, value)}
              />
            ) : (
              <TextInput
                accessibilityLabel={field.label}
                autoCapitalize={
                  field.type === "email" || formFieldIsSecret(field) ? "none" : "sentences"
                }
                autoComplete={
                  field.type === "otp"
                    ? "one-time-code"
                    : formFieldIsSecret(field)
                      ? "off"
                      : undefined
                }
                editable={!busy && !readOnly}
                keyboardType={
                  field.type === "email"
                    ? "email-address"
                    : field.type === "tel"
                      ? "phone-pad"
                      : field.type === "number" || field.type === "otp"
                        ? "numeric"
                        : "default"
                }
                multiline={field.type === "textarea"}
                onChangeText={(value) => set(field.id, value)}
                placeholder={
                  field.placeholder ?? (field.type === "date" ? "YYYY-MM-DD" : undefined)
                }
                placeholderTextColor={theme.textMuted}
                secureTextEntry={field.type !== "otp" && formFieldIsSecret(field)}
                style={[
                  text,
                  {
                    fontSize: 14,
                    lineHeight: 22,
                    letterSpacing: 0,
                    borderWidth: 1,
                    borderColor: theme.border,
                    backgroundColor: theme.field,
                    height: field.type === "textarea" ? 40 : 32,
                    textAlignVertical: field.type === "textarea" ? "top" : "center",
                    paddingVertical: field.type === "textarea" ? 8 : 4,
                    paddingHorizontal: 10,
                    borderRadius: 8,
                  },
                ]}
                value={String(values[field.id] ?? "")}
              />
            )}
          </View>
        ))}
        {form.submitAfterFill && (
          <Text style={{ color: theme.textMuted }}>
            After filling, this presses Enter on {form.domain}.
          </Text>
        )}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: "#c43e3e" }}>
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button("Continue", () => void submit(), !valid, true)}
          {message.senderBotId && button("Open the screen", () => void submit("escalated"))}
          {button("Dismiss", () => void submit("dismissed"))}
        </View>
      </>
    </View>
  );
}
