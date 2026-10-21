import { AUTO_REVIEW_RULE_MAX_CHARS, AUTO_REVIEW_RULE_MAX_ENTRIES, type AutoReviewSettings } from "@openteam/contracts/auto-review";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { InteractiveSwitch, SectionLabel, SettingsGroup, SettingsRow } from "./ui";

type RuleKind = "allowRules" | "askFirstRules";
const RULE_COPY: Record<RuleKind, { title: string; description: string; add: string; label: string }> = {
  allowRules: {
    title: "Allow rules",
    description: "OpenTeam usually goes ahead without asking for anything that matches, unless an Ask first rule also matches. Built-in safety checks still apply.",
    add: "Add Allow rule",
    label: "Allow rule",
  },
  askFirstRules: {
    title: "Ask first rules",
    description: "OpenTeam stops and asks you before anything that matches, even if it would otherwise go ahead. Ask first wins over Allow.",
    add: "Add Ask first rule",
    label: "Ask first rule",
  },
};
const buttonClass =
  "inline-flex h-7 shrink-0 items-center rounded-full border border-black/[0.04] bg-black/[0.035] px-3 text-[12px] hover:bg-black/[0.065] disabled:opacity-50 dark:border-white/[0.06] dark:bg-white/[0.07] dark:hover:bg-white/[0.1]";
const iconButtonClass =
  "grid size-6 shrink-0 place-items-center rounded text-foreground-tertiary hover:bg-black/[0.06] hover:text-foreground disabled:opacity-50 dark:hover:bg-white/[0.08]";

/** The reference's Auto-review settings: the on/off switch, then the user's Allow and Ask first rules. */
export function AutoReviewSettingsSection({ initial }: { initial?: AutoReviewSettings } = {}) {
  const [settings, setSettings] = useState<AutoReviewSettings | null>(initial ?? null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ kind: RuleKind; index: number | null; text: string } | null>(null);
  useEffect(() => {
    if (initial) return;
    api.autoReviewSettings().then(setSettings, (failure: unknown) => setLoadError(clientErrorMessage(failure, "Rules and Auto-review settings can't be shown or changed until they load")));
  }, [initial]);
  const save = async (change: Partial<AutoReviewSettings>) => {
    setSaving(true);
    setError("");
    try {
      setSettings(await api.saveAutoReviewSettings(change));
      return true;
    } catch (failure) {
      setError(clientErrorMessage(failure, "Couldn't save. Try again."));
      return false;
    } finally {
      setSaving(false);
    }
  };
  if (!settings)
    return (
      <>
        <SectionLabel>Auto-review</SectionLabel>
        <SettingsGroup>
          <SettingsRow anchors={["auto-review"]} title="Auto-review" description={loadError || "Loading…"} />
        </SettingsGroup>
      </>
    );
  const saveRule = async () => {
    if (!editing) return;
    const rules = [...settings[editing.kind]];
    const text = editing.text.trim();
    if (editing.index === null) rules.push(text);
    else if (text) rules[editing.index] = text;
    else rules.splice(editing.index, 1);
    if (await save({ [editing.kind]: rules.filter(Boolean) })) setEditing(null);
  };
  const ruleList = (kind: RuleKind) => {
    const copy = RULE_COPY[kind];
    const rules = settings[kind];
    return (
      <div className="border-t border-black/[0.065] py-3 first:border-t-0 dark:border-white/[0.07]" data-settings-anchor={kind === "allowRules" ? "auto-review-rules" : undefined}>
        <div className="text-[13px] leading-[17px] text-foreground">{copy.title}</div>
        <div className="mt-px max-w-[640px] text-[12px] leading-4 text-foreground-secondary">{copy.description}</div>
        <ul aria-label={copy.title} className="mt-2 flex flex-col gap-1">
          {rules.map((rule, index) =>
            editing?.kind === kind && editing.index === index ? null : (
              <li className="flex items-start gap-2 rounded-[8px] bg-black/[0.03] px-2.5 py-1.5 text-[12px] leading-4 dark:bg-white/[0.05]" key={`${index}:${rule}`}>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{rule}</span>
                <button aria-label={`Edit ${copy.label} ${index + 1}`} className={iconButtonClass} disabled={saving} onClick={() => setEditing({ kind, index, text: rule })} title="Edit rule" type="button">
                  <Pencil className="size-3.5" strokeWidth={1.75} />
                </button>
                <button
                  aria-label={`Delete ${copy.label} ${index + 1}`}
                  className={iconButtonClass}
                  disabled={saving}
                  onClick={() => void save({ [kind]: rules.filter((_, at) => at !== index) })}
                  title="Delete rule"
                  type="button"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.75} />
                </button>
              </li>
            )
          )}
        </ul>
        {editing?.kind === kind ? (
          <div className="mt-2 flex flex-col gap-2">
            <textarea
              aria-label={editing.index === null ? copy.add : `Edit ${copy.label} ${editing.index + 1}`}
              autoFocus
              className="min-h-[56px] w-full resize-y rounded-[8px] border border-black/[0.08] bg-background px-2.5 py-1.5 text-[12px] leading-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:border-white/[0.1]"
              maxLength={AUTO_REVIEW_RULE_MAX_CHARS}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
              placeholder={'Write one short, natural-language rule for each action. "Ask first" takes priority if rules conflict.'}
              value={editing.text}
            />
            <div className="flex gap-2">
              <button className={buttonClass} disabled={saving || (editing.index === null && !editing.text.trim())} onClick={() => void saveRule()} type="button">
                Save rule
              </button>
              <button aria-label="Cancel editing rule" className={buttonClass} disabled={saving} onClick={() => setEditing(null)} type="button">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className={`${buttonClass} mt-2`}
            disabled={saving || rules.length >= AUTO_REVIEW_RULE_MAX_ENTRIES}
            onClick={() => setEditing({ kind, index: null, text: "" })}
            type="button"
          >
            {copy.add}
          </button>
        )}
      </div>
    );
  };
  return (
    <>
      <SectionLabel>Auto-review</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["auto-review"]}
          control={<InteractiveSwitch checked={settings.enabled} disabled={saving} label="Auto-review" onChange={(enabled) => void save({ enabled })} />}
          description={
            settings.enabled
              ? "OpenTeam checks each action before it runs and asks you first when needed. Add rules to customize what it can do automatically."
              : "OpenTeam runs actions without checking them. Tools set to Needs approval still ask."
          }
          title="Auto-review"
        />
        {ruleList("allowRules")}
        {ruleList("askFirstRules")}
        <div className="border-t border-black/[0.065] py-2.5 text-[12px] leading-4 text-foreground-secondary dark:border-white/[0.07]">
          {settings.enabled ? "These rules apply only to you. Built-in safety checks always apply." : "Rules aren't used while Auto-review is off"}
        </div>
        {error && (
          <p className="pb-2.5 text-[12px] text-destructive" role="alert">
            {error}
          </p>
        )}
      </SettingsGroup>
    </>
  );
}
