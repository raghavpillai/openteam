/** A live DOM range follows edits without replacing existing mention tokens. */
export function voiceInsertionRange(editor: HTMLElement): Range {
  const selection = editor.ownerDocument.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    if (editor.contains(range.startContainer) && editor.contains(range.endContainer))
      return range.cloneRange();
  }
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}

export function insertVoiceTranscript(editor: HTMLElement, bookmark: Range | null, text: string) {
  const range =
    bookmark && editor.contains(bookmark.startContainer) && editor.contains(bookmark.endContainer)
      ? bookmark
      : voiceInsertionRange(editor);
  const before = editor.ownerDocument.createRange();
  before.selectNodeContents(editor);
  before.setEnd(range.startContainer, range.startOffset);
  const prefix = before.toString();
  // Match Grok's insertion rule: separate from the preceding word, preserve the suffix.
  const spacing = prefix && !/\s$/.test(prefix) && !/^\s/.test(text) ? " " : "";
  range.deleteContents();
  const node = editor.ownerDocument.createTextNode(spacing + text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  editor.focus();
  const selection = editor.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}
