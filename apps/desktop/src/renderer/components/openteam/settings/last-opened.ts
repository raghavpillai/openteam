/** "Last opened 5 minutes ago", "yesterday", "last week": when an offline computer was last connected. */
export function lastOpened(at: string | null, now = Date.now()) {
  if (!at) return "Not opened yet";
  const seconds = Math.round((Date.parse(at) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [["minute", 60], ["hour", 3600], ["day", 86_400], ["week", 604_800], ["month", 2_592_000], ["year", 31_536_000]];
  let [unit, size] = steps[0]!;
  for (const step of steps) if (Math.abs(seconds) >= step[1]) [unit, size] = step;
  return `Last opened ${format.format(Math.round(seconds / size), unit)}`;
}

