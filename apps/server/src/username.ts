// Owner usernames: 3–30 letters, numbers, dashes, underscores or dots, starting and ending with a
// letter or number. Sign-in ignores case, so the account keeps the case it was created with for
// display and matches it in any case.

const SEPARATORS = "-_.";

/** Why a new username isn't allowed, or null when it is. */
export const usernameProblem = (value: string): string | null => {
  const username = value.trim();
  if (!username) return "Enter a username.";
  if (/\s/.test(username)) return "Usernames can't contain spaces.";
  const invalid = [...username].find(
    (character) => !/[A-Za-z0-9]/.test(character) && !SEPARATORS.includes(character)
  );
  if (invalid)
    return `"${invalid}" isn't allowed. Use letters, numbers, dashes, underscores, or dots.`;
  if (username.length < 3 || username.length > 30) return "Use 3 to 30 characters.";
  if (SEPARATORS.includes(username[0]!) || SEPARATORS.includes(username.at(-1)!)) {
    return "Start and end with a letter or number.";
  }
  if (/[-_.]{2}/.test(username)) return "Use one dash, underscore, or dot at a time.";
  return null;
};

/** The stored sign-in name: usernames match in any case. */
export const usernameKey = (value: string): string => value.trim().toLowerCase();
