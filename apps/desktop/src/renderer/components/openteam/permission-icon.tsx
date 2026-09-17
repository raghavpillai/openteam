import { permissionGlyphs, type PermissionGlyph } from "@openteam/design-tokens/permission-icons";
import type { SVGProps } from "react";

export function PermissionIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: PermissionGlyph }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {permissionGlyphs[name].map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
