import type { PluginSetupFieldView } from "@openteam/contracts";
import { cn } from "../../../lib/cn";

export function PluginSetupFields({
  fields,
  values,
  onChange,
}: {
  fields: readonly PluginSetupFieldView[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 max-sm:grid-cols-1">
      {fields.map((field) => (
        <label
          className={cn("space-y-1", field.format === "mcp-url" && "col-span-2 max-sm:col-span-1")}
          key={field.key}
        >
          <span className="block text-[10px] font-medium text-foreground-secondary">
            {field.label}
          </span>
          {field.type === "boolean" ? (
            <div className="flex h-8 items-center">
              <input
                aria-label={field.label}
                className="size-4 accent-current"
                type="checkbox"
                checked={(values[field.key] ?? String(field.default ?? false)) === "true"}
                onChange={(event) => onChange(field.key, String(event.target.checked))}
              />
            </div>
          ) : (
            <input
              aria-label={field.label}
              required={field.required}
              className="h-8 w-full rounded-[7px] border border-black/[0.08] bg-background px-2.5 text-[10.5px] outline-none placeholder:text-foreground-tertiary focus:border-black/20 dark:border-white/10 dark:bg-[#1d1d1d] dark:focus:border-white/20"
              onChange={(event) => onChange(field.key, event.target.value)}
              placeholder={field.placeholder}
              type={
                field.secret
                  ? "password"
                  : field.format === "mcp-url"
                    ? "url"
                    : field.type === "number" || field.type === "integer"
                      ? "number"
                      : "text"
              }
              step={field.type === "integer" ? 1 : "any"}
              value={values[field.key] ?? String(field.default ?? "")}
            />
          )}
          {field.helpText && (
            <span className="block text-[9.5px] leading-3.5 text-foreground-tertiary">
              {field.helpText}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
