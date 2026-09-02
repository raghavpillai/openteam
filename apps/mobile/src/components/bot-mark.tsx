import { type BotAvatarShape, normalizeBotAvatarShape } from "@openbot/contracts/bot-avatar";
import {
  BOT_AVATAR_ARTWORK,
  BOT_AVATAR_NATIVE_ARTWORK,
  type BotAvatarEyeRect,
  type BotAvatarEyes,
  type BotAvatarNativePrimitive,
  botAvatarEyeRects,
} from "@openbot/design-tokens/bot-avatar-artwork";
import { memo } from "react";
import { View, type ViewStyle } from "react-native";

const eyeStyle = (eye: BotAvatarEyeRect, color: string, scale: number): ViewStyle => ({
  position: "absolute",
  backgroundColor: color,
  borderRadius: eye.rx * scale,
  height: eye.height * scale,
  left: eye.x * scale,
  top: eye.y * scale,
  transform: [{ rotate: `${eye.rotation}deg` }],
  width: eye.width * scale,
});

function EyePair({
  color = "#fff",
  scale,
  ...eyes
}: BotAvatarEyes & { color?: string; scale: number }) {
  const [leftEye, rightEye] = botAvatarEyeRects(eyes);
  return (
    <>
      <View style={eyeStyle(leftEye, color, scale)} />
      <View style={eyeStyle(rightEye, color, scale)} />
    </>
  );
}

const primitiveStyle = (
  primitive: BotAvatarNativePrimitive,
  color: string,
  scale: number
): ViewStyle => {
  if (primitive.kind === "triangle") {
    return {
      position: "absolute",
      backgroundColor: "transparent",
      borderBottomColor: color,
      borderBottomWidth: primitive.height * scale,
      borderLeftColor: "transparent",
      borderLeftWidth: (primitive.width * scale) / 2,
      borderRightColor: "transparent",
      borderRightWidth: (primitive.width * scale) / 2,
      height: 0,
      left: (primitive.x + primitive.width / 2) * scale,
      top: primitive.y * scale,
      width: 0,
    };
  }
  return {
    position: "absolute",
    backgroundColor: color,
    borderRadius:
      (primitive.kind === "ellipse"
        ? Math.min(primitive.width, primitive.height) / 2
        : primitive.radius) * scale,
    height: primitive.height * scale,
    left: primitive.x * scale,
    top: primitive.y * scale,
    transform: primitive.rotation ? [{ rotate: `${primitive.rotation}deg` }] : undefined,
    width: primitive.width * scale,
  };
};

const primitiveKey = (primitive: BotAvatarNativePrimitive): string => {
  const radius = primitive.kind === "rounded-rect" ? primitive.radius : 0;
  const rotation = "rotation" in primitive ? (primitive.rotation ?? 0) : 0;
  return `${primitive.kind}:${primitive.x}:${primitive.y}:${primitive.width}:${primitive.height}:${radius}:${rotation}`;
};

function ShapeArtwork({
  shape,
  color,
  faceColor,
  showFace,
  size,
}: {
  shape: BotAvatarShape;
  color: string;
  faceColor: string;
  showFace: boolean;
  size: number;
}) {
  const artwork = BOT_AVATAR_ARTWORK[shape];
  const scale = size / 40;
  return (
    <>
      {BOT_AVATAR_NATIVE_ARTWORK[shape].map((primitive) => (
        <View key={primitiveKey(primitive)} style={primitiveStyle(primitive, color, scale)} />
      ))}
      {showFace ? <EyePair {...artwork.eyes} color={faceColor} scale={scale} /> : null}
    </>
  );
}

export const BotMark = memo(function BotMark({
  color,
  faceColor = "#fff",
  icon,
  showFace = true,
  size = 48,
}: {
  color: string;
  faceColor?: string;
  icon?: string;
  showFace?: boolean;
  size?: number;
}) {
  const shape = normalizeBotAvatarShape(icon);
  return (
    <View
      accessibilityIgnoresInvertColors
      accessibilityLabel="Bot avatar"
      accessibilityRole="image"
      style={{ width: size, height: size }}
    >
      <ShapeArtwork
        color={color}
        faceColor={faceColor}
        shape={shape}
        showFace={showFace}
        size={size}
      />
    </View>
  );
});
