export function composerInputHeight(text: string, measuredHeight = 0, emptyHeight = 0): number {
  if (!text) return 22;
  const explicitHeight = text.split("\n").length * 22;
  return Math.min(102, Math.max(22, explicitHeight, measuredHeight - emptyHeight + 22));
}
