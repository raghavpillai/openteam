/** A closed object schema; omitted required lists stay omitted in the public schema. */
export const objectToolSchema = (
  properties: Record<string, unknown>,
  required?: readonly string[]
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required === undefined ? {} : { required }),
  additionalProperties: false,
});
