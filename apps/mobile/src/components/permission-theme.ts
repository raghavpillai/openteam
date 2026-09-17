import { useTheme } from "../theme";

/** Approval cards use the same contrast and state colors on both clients. */
export function usePermissionTheme() {
  const theme = useTheme();
  return {
    ...theme,
    text: theme.dark ? "#fcfcfc" : "#141414",
    textMuted: theme.dark ? "rgba(252,252,252,0.6)" : "rgba(20,20,20,0.6)",
    textFaint: theme.dark ? "#fcfcfc59" : "#14141474",
    field: theme.dark ? "#070707" : "#fcfcfc",
    border: theme.dark ? "#fcfcfc26" : "#14141426",
    separator: theme.dark ? "#fcfcfc1a" : "#1414141a",
    assistantBubble: theme.dark ? "#262626" : "#eeeeee",
    surfacePressed: theme.dark ? "#77777724" : "#77777710",
    selected: theme.dark ? "#77777752" : "#7777772b",
    options: theme.dark ? "#2f2f2f" : "#e8e8e8",
    success: theme.dark ? "#38d591" : "#009957",
    danger: theme.dark ? "#ff5667" : "#c21d2e",
    successBackground: theme.dark ? "#00c9722c" : "#00c97217",
    dangerBackground: theme.dark ? "#ff263c2c" : "#ff263c17",
    mutedBackground: theme.dark ? "#181818" : "#fcfcfc",
  };
}
