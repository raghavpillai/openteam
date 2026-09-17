import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { PermissionIcon } from "./permission-icon";
import { usePermissionTheme } from "./permission-theme";

/** Keep the compact form field while presenting an accessible, bounded option menu. */
export function PermissionSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { label: string; value: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const theme = usePermissionTheme();
  const field = useRef<View>(null);
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const screen = useWindowDimensions();
  const text = { color: theme.text, fontSize: 14, lineHeight: 20 };
  return (
    <>
      <Pressable
        ref={field}
        accessibilityRole="combobox"
        accessibilityLabel={label}
        accessibilityState={{ expanded: !!anchor, disabled }}
        disabled={disabled}
        onPress={() =>
          field.current?.measureInWindow((x, y, width, height) =>
            setAnchor({ x, y, width, height })
          )
        }
        style={{
          height: 32,
          paddingHorizontal: 10,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: 8,
          backgroundColor: theme.field,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          opacity: disabled ? 0.56 : 1,
        }}
      >
        <Text style={{ ...text, flex: 1 }}>
          {options.find((option) => option.value === value)?.label ?? "Select"}
        </Text>
        <PermissionIcon name="down" size={12} tintColor={theme.textMuted} />
      </Pressable>
      <Modal
        visible={!!anchor && !disabled}
        transparent
        animationType="none"
        onRequestClose={() => setAnchor(null)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close options"
          onPress={() => setAnchor(null)}
          style={{ flex: 1 }}
        />
        {anchor && (
          <View
            accessibilityViewIsModal
            style={{
              position: "absolute",
              left: Math.min(anchor.x, screen.width - anchor.width),
              top: Math.max(
                12,
                Math.min(
                  anchor.y + anchor.height + 4,
                  screen.height - Math.min(320, options.length * 40) - 24
                )
              ),
              width: anchor.width,
              maxHeight: 320,
              backgroundColor: theme.field,
              borderColor: theme.border,
              borderWidth: 1,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <ScrollView>
              {options.map((option) => (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked: value === option.value }}
                  onPress={() => {
                    onChange(option.value);
                    setAnchor(null);
                  }}
                  style={{
                    minHeight: 40,
                    paddingHorizontal: 10,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    backgroundColor: value === option.value ? theme.selected : theme.field,
                  }}
                >
                  <Text style={{ ...text, flex: 1 }}>{option.label}</Text>
                  {value === option.value && (
                    <PermissionIcon name="check" size={14} tintColor={theme.text} />
                  )}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
      </Modal>
    </>
  );
}
