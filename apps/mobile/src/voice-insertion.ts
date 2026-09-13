export interface VoiceSelection {
  start: number;
  end: number;
}

export function insertVoiceTranscript(
  draft: string,
  transcript: string,
  selection: VoiceSelection | null
) {
  const start = Math.max(0, Math.min(selection?.start ?? draft.length, draft.length));
  const end = Math.max(start, Math.min(selection?.end ?? start, draft.length));
  const prefix = draft.slice(0, start);
  const spacing = prefix && !/\s$/.test(prefix) && !/^\s/.test(transcript) ? " " : "";
  const insertion = spacing + transcript;
  return {
    text: prefix + insertion + draft.slice(end),
    selection: { start: start + insertion.length, end: start + insertion.length },
  };
}
