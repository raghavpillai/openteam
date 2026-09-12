/** Clipboard API on HTTPS, with a selection-based fallback for local HTTP previews. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // The browser may expose the API but deny it for this origin.
    }
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
    : [];
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    copied = document.execCommand("copy");
  } finally {
    field.remove();
    active?.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
  if (!copied) throw new Error("Clipboard is unavailable");
}
