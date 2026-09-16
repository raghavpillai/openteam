import {
  formatIdleGapTimestamp,
  shouldShowIdleGapTimestamp,
} from "@openteam/product-core/timestamps";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from "react-native";
import { useChatTheme } from "../chat-appearance";

function NewMessageDivider() {
  const opacity = useRef(new Animated.Value(0)).current;
  const growth = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => mounted && setReduceMotion(enabled),
      () => mounted && setReduceMotion(true)
    );
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion === null) return;
    if (reduceMotion) growth.setValue(1);
    const animation = Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(growth, {
        toValue: 1,
        duration: reduceMotion ? 0 : 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [growth, opacity, reduceMotion]);

  // Animate inside the fixed row so the entrance never changes message spacing.
  return (
    <Animated.View
      accessible
      accessibilityRole="text"
      accessibilityLabel="New messages"
      style={[styles.unread, { opacity }]}
    >
      <Animated.View
        style={[styles.rule, { transformOrigin: "100% 50%", transform: [{ scaleX: growth }] }]}
      />
      <Text style={styles.newLabel}>NEW</Text>
      <Animated.View
        style={[styles.rule, { transformOrigin: "0% 50%", transform: [{ scaleX: growth }] }]}
      />
    </Animated.View>
  );
}

export function ConversationMessageFrame({
  createdAt,
  previousCreatedAt,
  isNew,
  children,
}: {
  createdAt: string;
  previousCreatedAt?: string;
  isNew: boolean;
  children: ReactNode;
}) {
  const theme = useChatTheme();
  return (
    <View>
      {shouldShowIdleGapTimestamp(previousCreatedAt, createdAt) ? (
        <Text style={[styles.timestamp, { color: theme.textFaint }]}>
          {formatIdleGapTimestamp(createdAt)}
        </Text>
      ) : null}
      {isNew ? <NewMessageDivider /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  timestamp: { textAlign: "center", fontSize: 14, lineHeight: 20, marginTop: 19, marginBottom: 7 },
  unread: { height: 36, paddingBottom: 6, flexDirection: "row", alignItems: "center", gap: 10 },
  rule: { flex: 1, height: 1, backgroundColor: "rgba(0,108,235,0.5)" },
  newLabel: {
    color: "#006CEB",
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.5,
    fontWeight: "600",
  },
});
