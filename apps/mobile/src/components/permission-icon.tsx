import { permissionGlyphs, type PermissionGlyph } from "@openteam/design-tokens/permission-icons";
import Svg, { Path } from "react-native-svg";

export function PermissionIcon({
  name,
  size,
  tintColor,
}: {
  name: PermissionGlyph;
  size: number;
  tintColor: string;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={tintColor}
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
    >
      {permissionGlyphs[name].map((d, index) => (
        <Path key={index} d={d} />
      ))}
    </Svg>
  );
}
