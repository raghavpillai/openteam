import type { PluginConfigurationView } from "@openteam/contracts";
import type { ConfigValue } from "@openteam/plugin-sdk";
import { useState } from "react";
import { pluginSetupValues } from "../../../lib/plugin-setup-values";
import { ButtonPrimitive } from "../../ui/button-primitive";
import { PluginSetupFields } from "./plugin-setup-fields";

export function PluginPreferences({
  config,
  busy,
  onSave,
}: {
  config: PluginConfigurationView | null;
  busy: boolean;
  onSave: (values: Record<string, ConfigValue>) => Promise<boolean>;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const fields = config?.setup?.fields.filter((field) => !field.required && !field.secret) ?? [];
  if (!fields.length) return null;
  const values = {
    ...Object.fromEntries(
      Object.entries(config!.values).map(([key, value]) => [key, String(value)])
    ),
    ...edits,
  };
  const save = async () => {
    let submitted: Record<string, ConfigValue>;
    try {
      submitted = pluginSetupValues(fields, values);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the settings.");
      return;
    }
    if (await onSave(submitted)) setEdits({});
  };
  return (
    <details className="animated-disclosure mt-3 text-[11px]">
      <summary className="cursor-pointer text-foreground-secondary">Preferences</summary>
      <PluginSetupFields
        fields={fields}
        values={values}
        onChange={(key, value) => {
          setEdits((current) => ({ ...current, [key]: value }));
          setError(null);
        }}
      />
      {error && (
        <p role="alert" className="mt-2 text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <ButtonPrimitive
        className="mt-3 inline-flex h-[26px] items-center justify-center gap-1.5 rounded-full bg-[#77777717] px-3 text-[11px] disabled:opacity-45"
        disabled={busy || !Object.keys(edits).length}
        loading={busy}
        type="button"
        onClick={() => void save()}
      >
        Save preferences
      </ButtonPrimitive>
    </details>
  );
}
