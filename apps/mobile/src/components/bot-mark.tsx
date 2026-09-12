import { normalizeRobotAvatarShape } from "@openteam/contracts/robot-avatar";
import {
  ROBOT_AVATAR_ARTWORK,
  ROBOT_AVATAR_VIEW_BOX,
  robotAvatarFaceColor,
  type RobotAvatarNode,
} from "@openteam/design-tokens/robot-avatar-artwork";
import { memo } from "react";
// Import primitives directly so Metro omits the XML/CSS parsers and filter components.
import Svg from "react-native-svg/src/elements/Svg";
import Circle from "react-native-svg/src/elements/Circle";
import G from "react-native-svg/src/elements/G";
import Line from "react-native-svg/src/elements/Line";
import Polygon from "react-native-svg/src/elements/Polygon";
import Rect from "react-native-svg/src/elements/Rect";

function renderNode(
  node: RobotAvatarNode,
  key: number,
  color: string,
  faceColor: string
): React.ReactNode {
  const { style, ...attributes } = node.attributes;
  const props = Object.fromEntries(
    Object.entries(attributes)
      .filter(([name]) => !name.startsWith("data-"))
      .map(([name, value]) => [
        name,
        value === "currentColor"
          ? color
          : value === "var(--robot-face, #1b1b1d)"
            ? faceColor
            : value,
      ])
  );
  // Native SVG supports affine transforms; project the reference's 14° face turn onto its plane.
  if (typeof style === "object" && style.transform?.includes("perspective")) {
    props.transform = "translate(52 0) scale(0.9703 1) translate(-50 0)";
  }
  const children = node.children?.map((child, index) => renderNode(child, index, color, faceColor));
  switch (node.tag) {
    case "g":
      return (
        <G {...props} key={key}>
          {children}
        </G>
      );
    case "rect":
      return <Rect {...props} key={key} />;
    case "circle":
      return <Circle {...props} key={key} />;
    case "line":
      return <Line {...props} key={key} />;
    case "polygon":
      return <Polygon {...props} key={key} />;
  }
}

export const BotMark = memo(function BotMark({
  color,
  faceColor,
  icon,
  size = 48,
}: {
  color: string;
  faceColor?: string;
  icon?: string;
  size?: number;
}) {
  const shape = normalizeRobotAvatarShape(icon);
  return (
    <Svg
      accessibilityIgnoresInvertColors
      accessibilityLabel="Bot avatar"
      accessibilityRole="image"
      width={size}
      height={size}
      viewBox={ROBOT_AVATAR_VIEW_BOX}
    >
      {ROBOT_AVATAR_ARTWORK[shape].map((node, index) =>
        renderNode(node, index, color, faceColor ?? robotAvatarFaceColor(color))
      )}
    </Svg>
  );
});
