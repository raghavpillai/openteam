import type { BotView } from "@openteam/contracts";
import { DEFAULT_BOT_AVATAR } from "@openteam/contracts/bot-avatar";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  THINKING_SLOT_HEIGHT,
  thinkingIndicatorPresence,
  thinkingIndicatorTransition,
} from "../thinking-indicator-presence";
import { ThinkingRobot } from "./thinking-robot";

export function WorkingIndicator({
  name,
  bot,
  visible,
  active = true,
  onStop,
}: {
  name: string;
  bot?: Pick<BotView, "color" | "icon">;
  visible: boolean;
  active?: boolean;
  onStop?: () => void;
}) {
  const [present, setPresent] = useState(visible);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const phase = useSharedValue(0);
  // Keep the same avatar through its exit, including in multi-bot conversations.
  const retainedBot = useRef(bot);
  useEffect(() => {
    if (visible) retainedBot.current = bot;
  }, [bot, visible]);
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (reduced) => {
        if (!cancelled) setReduceMotion(reduced);
      },
      () => {
        if (!cancelled) setReduceMotion(true);
      }
    );
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (visible && !present) {
      setPresent(true);
      return;
    }
    if (!present || reduceMotion === null) return;
    let cancelled = false;
    const finishExit = () => {
      if (!cancelled) setPresent(false);
    };
    const steps = thinkingIndicatorTransition(phase.value, visible, reduceMotion);
    if (steps.length === 0) {
      if (!visible) finishExit();
      return;
    }
    // One UI-thread phase keeps height and opacity sequenced even while a reply
    // is rendering. Reversals continue from the current phase without snapping.
    phase.value = withSequence(
      ReduceMotion.Never,
      ...steps.map((step, index) =>
        withTiming(
          step.to,
          {
            duration: step.duration,
            easing:
              step.curve === "enter" ? Easing.bezier(0.23, 1, 0.32, 1) : Easing.inOut(Easing.cubic),
            // Motion preferences are handled by the plan; preserve its fade.
            reduceMotion: ReduceMotion.Never,
          },
          index === steps.length - 1 && !visible
            ? (finished) => {
                "worklet";
                if (finished) scheduleOnRN(finishExit);
              }
            : undefined
        )
      )
    );
    return () => {
      cancelled = true;
      cancelAnimation(phase);
    };
  }, [phase, present, reduceMotion, visible]);
  const slotStyle = useAnimatedStyle(() => ({
    height: thinkingIndicatorPresence(phase.value).height,
  }));
  const robotStyle = useAnimatedStyle(() => {
    const { opacity } = thinkingIndicatorPresence(phase.value);
    return {
      opacity,
      transform: reduceMotion
        ? []
        : [{ translateY: (1 - opacity) * 5 }, { scale: 0.84 + opacity * 0.16 }],
    };
  });
  if (!present) return null;
  const displayedBot = visible ? bot : retainedBot.current;
  return (
    <Animated.View
      style={[styles.slot, slotStyle]}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    >
      <View style={styles.row}>
        {/* Artwork padding remains fixed. The outer slot closes only after the
          artwork has faded, leaving no persistent blank footer. */}
        <Animated.View style={robotStyle}>
          <Pressable
            accessibilityLabel={`${name} is thinking. Stop response`}
            accessibilityHint="Double tap to stop the current response"
            accessibilityRole="button"
            disabled={!visible || !onStop}
            onPress={onStop}
            hitSlop={6}
          >
            <View
              accessibilityLabel={`${name} is thinking`}
              accessibilityRole="progressbar"
              style={styles.artwork}
            >
              <ThinkingRobot
                color={displayedBot?.color ?? DEFAULT_BOT_AVATAR.color}
                icon={displayedBot?.icon ?? DEFAULT_BOT_AVATAR.icon}
                active={active}
                size={40}
              />
            </View>
          </Pressable>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slot: { overflow: "hidden" },
  row: {
    height: THINKING_SLOT_HEIGHT,
    alignItems: "flex-start",
    paddingTop: 16,
    paddingBottom: 16,
  },
  artwork: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
});
