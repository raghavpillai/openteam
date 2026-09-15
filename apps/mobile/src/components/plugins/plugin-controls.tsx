import * as Haptics from "../../haptics";
import { Text, TextInput, View } from "react-native";
import { useTheme } from "../../theme";
import { NativeActionButton } from "../native-controls";
export function Button({
  children,
  onPress,
  disabled,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return <NativeActionButton title={children} disabled={disabled} onPress={onPress} />;
}
export function Field({
  label,
  value,
  onChange,
  secret = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
  multiline?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.text, fontWeight: "600" }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardAppearance={theme.dark ? "dark" : "light"}
        secureTextEntry={secret}
        multiline={multiline}
        value={value}
        onChangeText={onChange}
        style={{
          borderColor: theme.separator,
          borderWidth: 0.5,
          borderRadius: 12,
          backgroundColor: theme.field,
          padding: 12,
          fontSize: 17,
          color: theme.text,
          minHeight: multiline ? 100 : 44,
        }}
      />
    </View>
  );
}
export function Choices({
  label,
  values,
  current,
  onChange,
}: {
  label: string;
  values: readonly string[];
  current: string;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.text, fontWeight: "600" }}>{label}</Text>
      <NativeActionButton
        title={current}
        label={`${label}: ${current}`}
        symbol="chevron.up.chevron.down"
        variant="glass"
        actions={values.map((value) => ({ id: value, title: value, selected: current === value }))}
        onAction={(value) => {
          if (value === current || !values.includes(value)) return;
          void Haptics.selectionAsync();
          onChange(value);
        }}
      />
    </View>
  );
}
