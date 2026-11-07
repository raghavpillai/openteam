const URL_PATTERN = /https?:\/\/([^\s)]+)|www\.([^\s)]+)/gi;

export const normalizeVoiceText = (source: string): string => source
  .replace(/```[\s\S]*?```/g, "I sent a code block.")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/(^|\n)\s{0,3}#{1,6}\s*/g, "$1")
  .replace(/(^|\n)\s*[-*+]\s+/g, "$1")
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/__([^_]+)__/g, "$1")
  .replace(/\*([^*]+)\*/g, "$1")
  .replace(/_([^_]+)_/g, "$1")
  .replace(URL_PATTERN, (_match, domain: string | undefined, www: string | undefined) => ` ${domain ?? www}`)
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 20_000);

export const splitVoiceSentences = (text: string): string[] => text.match(/[^.!?。！？]+[.!?。！？]?/g)?.map(value => value.trim()).filter(Boolean) ?? [];
