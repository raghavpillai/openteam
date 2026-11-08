const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const WORKING = {
  zh: ["好的，我看看。", "嗯，稍等一下。", "收到，我来处理。", "好，我这就看。"],
  en: [
    "Sure, let me take a look.",
    "Okay, one moment.",
    "Got it, on it.",
    "Alright, let me check.",
  ],
} as const;

/** Spoken right after the user stops talking when they only greeted or tested the mic. The model's own answer can take several seconds, so silence is the wrong reply. */
const ANSWERING = {
  zh: ["在的，你说。", "我在，请讲。", "嗯，我在听。", "听得到，请说。"],
  en: ["I'm here, go ahead.", "Yes, I'm listening.", "I can hear you, go on.", "Hi, I'm here."],
} as const;

/** Spoken once when the call connects, before the user has said anything. */
const GREETING = {
  zh: [
    "你好，我在，有什么可以帮你？",
    "嗨，我在听，请说。",
    "你好呀，想聊点什么？",
    "我已经接通了，请说吧。",
  ],
  en: [
    "Hi, I'm here. What can I do for you?",
    "Hello, I'm listening.",
    "Hey, I'm connected. Go ahead.",
    "Hi there, what would you like to talk about?",
  ],
} as const;

/** Greetings, thanks, goodbyes and mic checks. They get a short spoken reply instead of "let me look", since there is nothing to look up. */
const SOCIAL = new Set([
  "你好",
  "您好",
  "嗨",
  "哈喽",
  "喂",
  "在吗",
  "你在吗",
  "你在不在",
  "能听到吗",
  "听得到吗",
  "你能听到吗",
  "在不在",
  "早上好",
  "早安",
  "晚上好",
  "晚安",
  "谢谢",
  "谢谢你",
  "多谢",
  "再见",
  "拜拜",
  "对话测试",
  "测试",
  "测试一下",
  "语音测试",
  "麦克风测试",
  "好的",
  "好",
  "嗯",
  "行",
  "可以",
  "对",
  "是的",
  "不用了",
  "没事",
  "hi",
  "hello",
  "hey",
  "thanks",
  "thank you",
  "bye",
  "goodbye",
  "test",
  "testing",
  "mic test",
  "ok",
  "okay",
  "yes",
  "no",
  "good morning",
  "good night",
]);

const compact = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+(?=\p{Script=Han})|(?<=\p{Script=Han})\s+/gu, "");

/** True when every punctuation-separated part is a greeting or mic check, as in "喂，你在吗？". */
export const isSocialUtterance = (text: string): boolean => {
  const parts = text
    .normalize("NFKC")
    .split(/[，。！？、,.!?;；…\n]+/u)
    .map(compact)
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => SOCIAL.has(part));
};

export type OpeningLanguage = keyof typeof WORKING;

export const openingLanguage = (text: string): OpeningLanguage => (CJK.test(text) ? "zh" : "en");

const choose = (
  lines: readonly string[],
  previous: string | null,
  random: () => number
): string => {
  const choices = lines.filter((line) => line !== previous);
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))] ?? lines[0]!;
};

/**
 * The fixed line to speak the moment the user stops talking: a short answer to a greeting or
 * mic check, or an acknowledgement that work is starting. Never the same line twice in a row.
 */
export const pickOpening = (
  text: string,
  previous: string | null,
  random: () => number = Math.random
): string => {
  const language = openingLanguage(text);
  return choose(
    isSocialUtterance(text) ? ANSWERING[language] : WORKING[language],
    previous,
    random
  );
};

/** A random greeting for when the call connects; the language is the one the voice is configured for. */
export const pickGreeting = (language: string, random: () => number = Math.random): string =>
  choose(GREETING[/^zh/i.test(language) ? "zh" : "en"], null, random);
