import { Ajv } from "ajv";
import addFormats from "ajv-formats";

/** Avoid grouped-regex stack limits on valid multi-megabyte MCP byte fields. */
export const isBase64 = (value: string): boolean =>
  value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

export function createToolValidator(schema: Readonly<Record<string, unknown>>) {
  const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat("byte", { type: "string", validate: isBase64 });
  const validate = ajv.compile(schema);
  return (value: unknown) => {
    const valid = validate(value);
    return { valid: Boolean(valid), errorMessage: valid ? undefined : ajv.errorsText(validate.errors) };
  };
}
