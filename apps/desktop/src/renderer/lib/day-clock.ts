/** Refresh relative dates at midnight, after sleep, and after clock changes. */
export function subscribeDayClock(
  onChange: (now: Date) => void,
  target: Pick<Window, "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener"> = window,
  page: Pick<Document, "addEventListener" | "removeEventListener"> = document,
) {
  let timer = 0;
  let previousDay = "";
  const refresh = () => {
    target.clearTimeout(timer);
    const now = new Date();
    const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    if (day !== previousDay) {
      previousDay = day;
      onChange(now);
    }
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    // The periodic check also catches clock/time-zone changes while focused.
    timer = target.setTimeout(refresh, Math.max(1, Math.min(60_000, midnight.getTime() - now.getTime())));
  };
  refresh();
  target.addEventListener("focus", refresh);
  page.addEventListener("visibilitychange", refresh);
  return () => {
    target.clearTimeout(timer);
    target.removeEventListener("focus", refresh);
    page.removeEventListener("visibilitychange", refresh);
  };
}
