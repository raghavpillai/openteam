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

const FILLER_CHARACTERS = /^[嗯啊呃哦噢唉哎额呀哈呵嘿哼唔喔诶欸]+$/u;
const FILLER_WORDS = new Set(["uh", "uhh", "um", "umm", "hm", "hmm", "mm", "mmm", "ah", "oh", "er", "erm", "eh", "huh", "ha", "haha"]);
const SHORT_REPLIES = new Set(["好", "是", "对", "行", "不", "要", "有", "没", "停", "等", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "零"]);

/**
 * False for a transcript that is only a filler sound or a single stray character, which is
 * what room noise and distant voices usually turn into. Short answers such as 好, 对 or a
 * number still pass.
 */
export const isMeaningfulTranscript = (text: string): boolean => {
  const words = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  if (words.every(word => FILLER_WORDS.has(word) || FILLER_CHARACTERS.test(word))) return false;
  const compact = words.join("");
  if (/^\p{N}+$/u.test(compact)) return true;
  const ideographic = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(compact);
  return compact.length >= 2 || (ideographic && SHORT_REPLIES.has(compact));
};

export const splitVoiceSentences = (text: string): string[] => text.match(/[^.!?。！？]+[.!?。！？]?/g)?.map(value => value.trim()).filter(Boolean) ?? [];
