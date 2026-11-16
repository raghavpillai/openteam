// Presentational copies of current desktop/iOS chrome shared by landing previews:
// the centered conversation pill (desktop-header.tsx), the file card and its paper
// glyph (file-attachment.tsx, attachment-visuals.tsx). Sample data only.
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import "./app-ui.css";

export function ConversationPill({
  avatar,
  name,
  chevron = false,
  className = "",
}: {
  avatar: ReactNode;
  name: string;
  chevron?: boolean;
  className?: string;
}) {
  return (
    <div className={`au-pill ${className}`}>
      <span className="au-pill-avatar">{avatar}</span>
      <strong>{name}</strong>
      {chevron ? <ChevronRight className="au-pill-chevron" size={14} aria-hidden="true" /> : null}
    </div>
  );
}

const STRIPES: Record<string, string> = {
  pdf: "#fb2b3e",
  docx: "#1680f3",
  csv: "#10ab61",
  xlsx: "#10ab61",
  pptx: "#ee620d",
};

export function FileGlyph({ fileName }: { fileName: string }) {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const stripe = STRIPES[extension];
  return (
    <span className="au-glyph" aria-hidden="true">
      <span className="au-glyph-paper">
        <span className={`au-glyph-ink ${stripe ? "has-stripe" : ""}`}>
          <i style={{ width: 24 }} />
          {stripe ? (
            <span className="au-glyph-grid">
              <span>
                <i style={{ width: 11 }} />
                <i style={{ width: 11 }} />
              </span>
              <i style={{ width: 11, height: 11 }} />
            </span>
          ) : (
            <>
              <i style={{ width: 20 }} />
              <i style={{ width: 24 }} />
              <i style={{ width: 16 }} />
            </>
          )}
        </span>
        {stripe ? <span className="au-glyph-stripe" style={{ background: stripe }} /> : null}
      </span>
    </span>
  );
}

export function FileCard({
  fileName,
  detail,
  className = "",
}: {
  fileName: string;
  detail: ReactNode;
  className?: string;
}) {
  const dot = fileName.lastIndexOf(".");
  return (
    <article className={`au-file ${className}`} aria-label={fileName}>
      <FileGlyph fileName={fileName} />
      <span className="au-file-text">
        <strong>
          <span>{dot > 0 ? fileName.slice(0, dot) : fileName}</span>
          {dot > 0 ? fileName.slice(dot) : ""}
        </strong>
        <small>{detail}</small>
      </span>
    </article>
  );
}
