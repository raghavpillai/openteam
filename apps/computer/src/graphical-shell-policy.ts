import type { SubagentType } from "@openbot/contracts";

interface DeniedGraphicalShellPattern {
  label: string;
  pattern: RegExp;
}

const DENIED_GRAPHICAL_SHELL_PATTERNS: readonly DeniedGraphicalShellPattern[] = [
  {
    label: "desktop input injection",
    pattern:
      /(^|[^A-Za-z0-9_])(?:xdotool|xte|xautomation|ydotool|wtype|cliclick|xvkbd|wmctrl|xinput|xdo|dotool)(?=$|[^A-Za-z0-9_])/i,
  },
  {
    label: "graphical display selection",
    pattern: /(?:^|[\s;&|()])(?:export\s+)?(?:DISPLAY|XAUTHORITY)\s*=|\/tmp\/\.X11-unix/i,
  },
  {
    label: "OpenBot screen launcher",
    pattern: /(^|[^A-Za-z0-9_])(?:openbot-screen-launch|box-chrome)(?=$|[^A-Za-z0-9_])/i,
  },
  {
    label: "browser debugging endpoint discovery",
    pattern:
      /OPENBOT_BROWSER_DEBUG_PORT|--remote-debugging-port|\/json\/(?:version|list|new|activate|close)|devtools\/browser/i,
  },
  {
    label: "browser debugging port access",
    pattern:
      /(?:127(?:\.[0-9]{1,3}){1,3}|localhost|0\.0\.0\.0|\[::1\]):(?:92(?:2[2-9]|[3-9][0-9])|93[0-9]{2})\b/i,
  },
  {
    label: "browser debugging port probing",
    pattern:
      /(?:curl|wget|nc|ncat|socat)\s+[^;&|]*(?:127(?:\.[0-9]{1,3}){1,3}|localhost|0\.0\.0\.0|\[::1\])[^;&|]*\b(?:92(?:2[2-9]|[3-9][0-9])|93[0-9]{2})\b/i,
  },
  {
    label: "raw browser CDP attachment",
    pattern: /connectOverCDP|chrome-remote-interface/i,
  },
  {
    label: "graphical process inspection",
    pattern:
      /(?:^|[;&|]\s*|\s)(?:ps|pgrep|pidof)(?:\s+[^;&|]*)?(?:chrom(?:e|ium)|Xvfb|x11vnc|openbot-screen)/i,
  },
];

export const graphicalShellBoundaryViolation = (
  command: string,
  subagentType: SubagentType | null
): string | null => {
  if (subagentType === "computerUse") return null;
  return (
    DENIED_GRAPHICAL_SHELL_PATTERNS.find(({ pattern }) => pattern.test(command))?.label ?? null
  );
};

export const assertGraphicalShellBoundary = (
  command: string,
  subagentType: SubagentType | null
): void => {
  const violation = graphicalShellBoundaryViolation(command, subagentType);
  if (!violation) return;
  const route =
    subagentType === "browserUse"
      ? "Use the direct browser_* tools for page interaction."
      : "Delegate page interaction to browserUse and pixel desktop interaction to computerUse.";
  throw new Error(`Graphical Shell access is unavailable (${violation}). ${route}`);
};
