import { useId, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Defs from "react-native-svg/src/elements/Defs";
import Rect from "react-native-svg/src/elements/Rect";
import Stop from "react-native-svg/src/elements/Stop";
import Svg from "react-native-svg/src/elements/Svg";
import { useTheme } from "../theme";

// Load only the native primitive, using the library's published declaration types.
const LinearGradient = require("react-native-svg/src/elements/LinearGradient")
  .default as typeof import("react-native-svg").LinearGradient;

/** Keeps the chrome legible while the conversation continues underneath it. */
export function ChatChromeFade({
  edge,
  style,
}: {
  edge: "top" | "bottom";
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const id = useId();
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <View
      pointerEvents="none"
      accessible={false}
      onLayout={({ nativeEvent: { layout } }) => {
        setSize((current) =>
          current.width === layout.width && current.height === layout.height
            ? current
            : { width: layout.width, height: layout.height }
        );
      }}
      style={[StyleSheet.absoluteFill, style]}
    >
      <Svg width={size.width} height={size.height}>
        <Defs>
          {/* Use measured coordinates so the native fade scales with keyboard resizing. */}
          <LinearGradient
            id={id}
            gradientUnits="userSpaceOnUse"
            x1={0}
            y1={edge === "top" ? 0 : size.height}
            x2={0}
            y2={edge === "top" ? size.height : 0}
          >
            <Stop offset="0" stopColor={theme.background} stopOpacity="1" />
            <Stop
              offset={edge === "top" ? "0.20" : "0.18"}
              stopColor={theme.background}
              stopOpacity={edge === "top" ? "0.85" : "0.9"}
            />
            <Stop
              offset={edge === "top" ? "0.55" : "0.65"}
              stopColor={theme.background}
              stopOpacity={edge === "top" ? "0.25" : "0.35"}
            />
            <Stop offset="1" stopColor={theme.background} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect width={size.width} height={size.height} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
