export const MAX_DOCUMENT_ARCHIVE_ENTRIES = 4_096;
export const MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES = 96 * 1024 * 1024;
export const MAX_DOCUMENT_PREVIEW_HTML_CHARS = 8 * 1024 * 1024;

const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const MAX_ZIP_COMMENT_BYTES = 65_535;

const previewLimitError = () =>
  new Error("This document is too large or complex to preview. Download it to open the full file.");

/**
 * Bounds ZIP expansion before Mammoth or SheetJS inflate document contents.
 * Non-ZIP spreadsheet formats pass through to their already input-bounded
 * parser. ZIP64 is unnecessary under the 12/16 MiB source caps and is rejected
 * rather than trusting truncated 32-bit sizes.
 */
export const assertBoundedDocumentArchive = (buffer: ArrayBuffer): void => {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 4) return;
  const view = new DataView(buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== ZIP_LOCAL_FILE) return;

  const searchStart = Math.max(0, bytes.byteLength - (MAX_ZIP_COMMENT_BYTES + 22));
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("This document archive is invalid.");

  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    entryCount > MAX_DOCUMENT_ARCHIVE_ENTRIES ||
    directoryOffset + directorySize > endOffset
  ) {
    throw previewLimitError();
  }

  let offset = directoryOffset;
  let expandedBytes = 0;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE) {
      throw new Error("This document archive is invalid.");
    }
    const expanded = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    expandedBytes += expanded;
    if (expandedBytes > MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES) throw previewLimitError();
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  if (offset !== directoryOffset + directorySize) {
    throw new Error("This document archive is invalid.");
  }
};

export const assertBoundedDocumentHtml = (html: string): string => {
  if (html.length > MAX_DOCUMENT_PREVIEW_HTML_CHARS) throw previewLimitError();
  return html;
};
