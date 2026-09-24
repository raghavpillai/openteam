/** PostgreSQL JSON/text cannot store NUL or unpaired UTF-16 surrogates. */
export const postgresText = (text: string): string => text.replace(
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
  "\uFFFD"
);

export function postgresJson(value: unknown): any {
  const clean = (input: any): any => {
    if (typeof input === "string") return postgresText(input);
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === "object") return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [postgresText(key), clean(item)])
    );
    return input;
  };
  return clean(JSON.parse(JSON.stringify(value)));
}
