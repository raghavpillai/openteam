/**
 * The reference shows the model a user's images ahead of their words in the same message.
 * Pi stores a prompt as its text followed by its images; this puts the images first in
 * what each call sends, leaving the stored session untouched.
 */
export const imagesBeforeText = <T extends { role?: unknown; content?: unknown }>(messages: readonly T[]): T[] =>
  messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    const parts = message.content as Array<{ type?: unknown }>;
    const firstText = parts.findIndex((part) => part.type === "text");
    const lastImage = parts.findLastIndex((part) => part.type === "image");
    if (firstText === -1 || lastImage < firstText) return message;
    return {
      ...message,
      content: [...parts.filter((part) => part.type === "image"), ...parts.filter((part) => part.type !== "image")],
    };
  });
