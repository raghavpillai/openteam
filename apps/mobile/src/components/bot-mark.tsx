import { normalizeRobotAvatarShape } from "@openteam/contracts/robot-avatar";
import {
  ROBOT_AVATAR_ARTWORK,
  ROBOT_AVATAR_VIEW_BOX,
  type RobotAvatarNode,
  robotAvatarFaceColor,
} from "@openteam/design-tokens/robot-avatar-artwork";
import { memo, type ReactNode } from "react";
import Circle from "react-native-svg/src/elements/Circle";
import G from "react-native-svg/src/elements/G";
import Line from "react-native-svg/src/elements/Line";
import Polygon from "react-native-svg/src/elements/Polygon";
import Rect from "react-native-svg/src/elements/Rect";
// Import primitives directly so Metro omits the XML/CSS parsers and filter components.
import Svg from "react-native-svg/src/elements/Svg";

type PartRenderer = (node: RobotAvatarNode, content: ReactNode, index: number) => ReactNode;

function renderNode(
  node: RobotAvatarNode,
  key: number,
  color: string,
  faceColor: string,
  renderPart?: PartRenderer
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
  const children = node.children?.map((child, index) =>
    renderNode(child, index, color, faceColor, renderPart)
  );
  const wrap = (content: ReactNode) => (renderPart ? renderPart(node, content, key) : content);
  switch (node.tag) {
    case "g":
      return wrap(
        <G {...props} key={key}>
          {children}
        </G>
      );
    case "rect":
      return wrap(<Rect {...props} key={key} />);
    case "circle":
      return wrap(<Circle {...props} key={key} />);
    case "line":
      return wrap(<Line {...props} key={key} />);
    case "polygon":
      return wrap(<Polygon {...props} key={key} />);
  }
}

export function RobotArtwork({
  color,
  icon,
  faceColor,
  renderPart,
}: {
  color: string;
  icon?: string;
  faceColor?: string;
  renderPart?: PartRenderer;
}) {
  return (
    <>
      {ROBOT_AVATAR_ARTWORK[normalizeRobotAvatarShape(icon)].map((node, index) =>
        renderNode(node, index, color, faceColor ?? robotAvatarFaceColor(color), renderPart)
      )}
    </>
  );
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
  return (
    <Svg
      accessibilityIgnoresInvertColors
      accessibilityLabel="Bot avatar"
      accessibilityRole="image"
      width={size}
      height={size}
      viewBox={ROBOT_AVATAR_VIEW_BOX}
    >
      <RobotArtwork color={color} faceColor={faceColor} icon={icon} />
    </Svg>
  );
});
