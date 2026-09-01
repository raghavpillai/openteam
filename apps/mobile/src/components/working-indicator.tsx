import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";

const COLORS = ["#8E5CF6", "#D43683", "#F06B32"];

export function WorkingIndicator({ name, onStop }: { name: string; onStop?: () => void }) {
  const theme = useTheme();
  const values = useRef(COLORS.map(() => new Animated.Value(0.42))).current;

  useEffect(() => {
    const animations = values.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 130),
          Animated.timing(value, {
            toValue: 1,
            duration: 420,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 0.42,
            duration: 420,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.delay((values.length - index - 1) * 130),
        ])
      )
    );
    animations.forEach((animation) => {
      animation.start();
    });
    return () =>
      animations.forEach((animation) => {
        animation.stop();
      });
  }, [values]);

  return (
    <View style={styles.row}>
      <View
        accessibilityLabel={`${name} is working`}
        accessibilityRole="progressbar"
        style={styles.progress}
      >
        <View style={styles.dots}>
          {values.map((value, index) => (
            <Animated.View
              key={COLORS[index]}
              style={[
                styles.dot,
                { backgroundColor: COLORS[index], opacity: value, transform: [{ scale: value }] },
              ]}
            />
          ))}
        </View>
        <Text style={[styles.label, { color: theme.textMuted }]}>{name} is working</Text>
      </View>
      {onStop ? (
        <Pressable
          accessibilityLabel={`Stop ${name}`}
          accessibilityRole="button"
          onPress={onStop}
          style={({ pressed }) => [styles.stop, pressed && styles.pressed]}
        >
          <Text style={[styles.stopLabel, { color: theme.danger }]}>Stop</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  progress: { flex: 1, flexDirection: "row", alignItems: "center", gap: 11 },
  dots: { width: 34, flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: "500" },
  stop: { minWidth: 48, minHeight: 40, alignItems: "center", justifyContent: "center" },
  stopLabel: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
  pressed: { opacity: 0.6 },
});
