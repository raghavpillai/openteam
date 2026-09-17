/** Independently drawn approval glyphs shared by web and native renderers. */
export const permissionGlyphs = {
  check: ["m2.5 8 3.7 3.7L13.5 4"],
  close: ["m3 3 10 10m0-10L3 13"],
  key: ["M14.3 7.5a2.6 3.8 0 1 1-5.2 0 2.6 3.8 0 1 1 5.2 0", "M9.1 7.5H1v3.7m2.7-3.7v2.4"],
  shield: ["M8 1.5 14 3v5c0 3.2-3.6 5.6-6 6.5C5.6 13.6 2 11.2 2 8V3Z", "m5.5 7.8 1.7 1.7 3.3-3.4"],
  right: ["m5.5 2.5 5 5.5-5 5.5"],
  down: ["m2.5 5.5 5.5 5 5.5-5"],
  warning: [
    "M7 1.8a1.15 1.15 0 0 1 2 0l6 10.6a1.15 1.15 0 0 1-1 1.8H2a1.15 1.15 0 0 1-1-1.8Z",
    "M8 5v3.5m0 2.7v.1",
  ],
} as const;
export type PermissionGlyph = keyof typeof permissionGlyphs;
