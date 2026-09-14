import { normalizeRobotAvatarShape } from "@openteam/contracts/robot-avatar";
import {
  ROBOT_AVATAR_VIEW_BOX,
  type RobotAvatarNode,
  robotAvatarTempo,
} from "@openteam/design-tokens/robot-avatar-artwork";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, AppState } from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedProps,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import G from "react-native-svg/src/elements/G";
import Svg from "react-native-svg/src/elements/Svg";
import { robotNodeCenter, robotThinkingPose } from "../robot-thinking-motion";
import { RobotArtwork } from "./bot-mark";

const AnimatedGroup = Animated.createAnimatedComponent(G);

function MovingPart({
  part,
  center,
  limit = 0,
  index = 0,
  clock,
  tempo,
  children,
}: {
  part: string;
  center: [number, number];
  limit?: number;
  index?: number;
  clock: SharedValue<number>;
  tempo: number;
  children: ReactNode;
}) {
  const animatedProps = useAnimatedProps(() =>
    robotThinkingPose(part, clock.value, tempo, limit, index, center)
  );
  return <AnimatedGroup animatedProps={animatedProps}>{children}</AnimatedGroup>;
}

export function ThinkingRobot({
  color,
  icon,
  size = 32,
  active = true,
}: {
  color: string;
  icon?: string;
  size?: number;
  active?: boolean;
}) {
  const [reduceMotion, setReduceMotion] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const clock = useSharedValue(0);
  const tempo = robotAvatarTempo(normalizeRobotAvatarShape(icon)) * 1000;
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduceMotion(value);
      })
      .catch(() => {
        /* Keep motion disabled when the accessibility setting is unavailable. */
      });
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    const app = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => {
      mounted = false;
      motion.remove();
      app.remove();
    };
  }, []);
  const frame = useFrameCallback(({ timeSincePreviousFrame }) => {
    clock.value += timeSincePreviousFrame ?? 0;
  }, false);
  const animate = active && foreground && !reduceMotion;
  useEffect(() => {
    frame.setActive(animate);
    return () => frame.setActive(false);
  }, [animate, frame]);
  const renderPart = useCallback(
    (node: RobotAvatarNode, content: ReactNode, index: number) => {
      if (!animate) return content;
      if (node.attributes["data-hide"] === "1")
        return (
          <G key={index} opacity={0}>
            {content}
          </G>
        );
      const part = node.attributes["data-p"];
      if (typeof part !== "string") return content;
      return (
        <MovingPart
          key={index}
          part={part}
          center={robotNodeCenter(node)}
          limit={Number(node.attributes["data-lim"] ?? 0)}
          index={index}
          clock={clock}
          tempo={tempo}
        >
          {content}
        </MovingPart>
      );
    },
    [animate, clock, tempo]
  );
  const artwork = <RobotArtwork color={color} icon={icon} renderPart={renderPart} />;
  return (
    <Svg accessible={false} width={size} height={size} viewBox={ROBOT_AVATAR_VIEW_BOX}>
      {animate ? (
        <MovingPart part="body" center={[50, 50]} clock={clock} tempo={tempo}>
          {artwork}
        </MovingPart>
      ) : (
        artwork
      )}
    </Svg>
  );
}
