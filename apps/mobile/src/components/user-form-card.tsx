import {
  formFieldIsSecret,
  validateUserFormValues,
  type UserForm,
} from "@openteam/contracts/review-cards";
import type { ChannelMessageView } from "@openteam/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useOpenTeam } from "../state/openteam-context";
import { useTheme } from "../theme";

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
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const state = String((message.metadata as Record<string, unknown>).cardState ?? "pending");
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
  const submit = async (dismiss = false) => {
    if (inFlight.current || readOnly) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const accepted = dismiss
        ? await api.dismissUserForm(message.id)
        : await api.submitUserForm(message.id, values, save);
      if (accepted) setValues({});
    } catch {
      setError("The form could not be completed. Check the page and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const text = { color: theme.text };
  const button = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy || readOnly}
      onPress={onPress}
      style={{
        padding: 10,
        borderWidth: 1,
        borderColor: theme.textMuted,
        borderRadius: 8,
        opacity: disabled || busy || readOnly ? 0.4 : 1,
      }}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={{ backgroundColor: theme.assistantBubble, padding: 14, borderRadius: 16, gap: 12 }}
    >
      <Text style={[text, { fontSize: 17, fontWeight: "600" }]}>{form.title}</Text>
      {state !== "pending" ? (
        <Text style={text}>
          {state === "dismissed"
            ? "Form dismissed"
            : state === "expired"
              ? "This form expired. Request a new form to continue."
              : state === "submitted"
                ? "Form submitted. Your answers were kept out of the conversation."
                : "Some fields need recovery. The bot can check the destination."}
        </Text>
      ) : (
        <>
          <Text style={text}>{form.instruction}</Text>
          <Text style={{ color: theme.textMuted }}>
            {form.domain
              ? `Fill only on ${form.domain}`
              : "No destination website. Answers will not be filled into a page."}
          </Text>
          {form.fields.map((field) => (
            <View key={field.id} style={{ gap: 6 }}>
              <Text style={text}>
                {field.label}
                {field.required ? " *" : ""}
              </Text>
              {field.type === "checkbox" ? (
                button(values[field.id] === true ? "✓ Selected" : "Select", () =>
                  set(field.id, values[field.id] !== true)
                )
              ) : field.type === "select" ? (
                <View style={{ gap: 5 }}>
                  {field.options?.map((option) => (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: values[field.id] === option.value }}
                      disabled={busy || readOnly}
                      key={option.value}
                      onPress={() => set(field.id, option.value)}
                      style={{ padding: 8 }}
                    >
                      <Text style={text}>
                        {values[field.id] === option.value ? "●" : "○"} {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : (
                <TextInput
                  accessibilityLabel={field.label}
                  autoCapitalize={
                    field.type === "email" || formFieldIsSecret(field) ? "none" : "sentences"
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
                  secureTextEntry={formFieldIsSecret(field)}
                  style={[
                    text,
                    { borderWidth: 1, borderColor: theme.textMuted, padding: 10, borderRadius: 8 },
                  ]}
                  value={String(values[field.id] ?? "")}
                />
              )}
            </View>
          ))}
          {form.fields.some((field) => !formFieldIsSecret(field)) &&
            button(`${save ? "✓ " : ""}Save nonsecret info for future forms`, () => setSave(!save))}
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
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            {button("Dismiss", () => void submit(true))}
            {button(
              form.submitAfterFill ? "Fill and press Enter" : "Continue",
              () => void submit(),
              !valid
            )}
          </View>
        </>
      )}
    </View>
  );
}
