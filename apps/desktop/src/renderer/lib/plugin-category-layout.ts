/** Keep a single row of categories, reserving space for the More/Hide control. */
export function visiblePluginCategoryCount(
  availableWidth: number,
  widths: readonly number[],
  gap: number,
  toggleWidth: number
): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  if (total <= availableWidth) return widths.length;
  let used = toggleWidth;
  let count = 0;
  for (const width of widths) {
    if (used + gap + width > availableWidth) break;
    used += gap + width;
    count++;
  }
  return count;
}
