import * as Haptics from "../../haptics";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTheme } from "../../theme";
export function Button({
  children,
  onPress,
  disabled,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{
        backgroundColor: theme.accent,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 9,
        opacity: disabled ? 0.4 : 1,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color: "white", fontWeight: "600" }}>{children}</Text>
    </Pressable>
  );
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
        secureTextEntry={secret}
        multiline={multiline}
        value={value}
        onChangeText={onChange}
        style={{
          borderColor: theme.separator,
          borderWidth: 1,
          borderRadius: 8,
          padding: 10,
          color: theme.text,
          minHeight: multiline ? 100 : 42,
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
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {values.map((value) => (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: current === value }}
            key={value}
            onPress={() => {
              if (value === current) return;
              void Haptics.selectionAsync();
              onChange(value);
            }}
            style={{
              padding: 9,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: current === value ? theme.accent : theme.separator,
            }}
          >
            <Text style={{ color: current === value ? theme.accent : theme.text }}>{value}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
