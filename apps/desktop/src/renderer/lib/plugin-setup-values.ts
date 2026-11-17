import type { PluginSetupFieldView } from "@openteam/contracts";
import { validateValues } from "@openteam/plugin-sdk/configuration";

/** Convert form input to declared types and include defaults in the saved values. */
export function pluginSetupValues(
  fields: readonly PluginSetupFieldView[],
  inputs: Record<string, string>
) {
  return validateValues(
    fields,
    Object.fromEntries(
      fields.flatMap((field) => {
        const input = inputs[field.key];
        if (input === undefined || !input.trim()) return [];
        const value = field.secret ? input : input.trim();
        return [
          [
            field.key,
            field.type === "number" || field.type === "integer"
              ? Number(value)
              : field.type === "boolean" && (value === "true" || value === "false")
                ? value === "true"
                : value,
          ],
        ];
      })
    )
  );
}
