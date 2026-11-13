/** Raw provider URLs are data for our server; never renderer image destinations. */
export function presentationImageResource(source?: string): string | null {
  if (!source || source.length > 8192) return null;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return `/api/v0/presentation-image?${new URLSearchParams({ url: source })}`;
  } catch { return null; }
}
