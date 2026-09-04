import { Pencil, Trash2 } from "lucide-react";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { InteractiveSwitch, SectionLabel, SettingsGroup, SettingsRow } from "./ui";

export default function GeneralBotSettings() {
  const [permissions, setPermissions] = useState<OpenTeamPermissionSettings | null>(null);
  const [ruleKind, setRuleKind] = useState<"allow" | "block">("allow");
  const [rule, setRule] = useState("");
  const [editingRule, setEditingRule] = useState<{
    kind: "allow" | "block";
    instruction: string;
  } | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.openteam?.permissions
      .get()
      .then((value) => active && setPermissions(value))
      .catch(
        (error) =>
          active && setPermissionError(clientErrorMessage(error, "Could not load permissions"))
      );
    return () => {
      active = false;
    };
  }, []);

  const updatePermissions = (request: {
    localToolPermission?: OpenTeamPermissionSettings["localToolPermission"];
    autoReviewEnabled?: boolean;
  }) => {
    setPermissionError(null);
    void window.openteam?.permissions
      .update(request)
      .then(setPermissions)
      .catch((error) =>
        setPermissionError(clientErrorMessage(error, "Could not update permissions"))
      );
  };

  const addRule = () => {
    const instruction = rule.trim();
    if (!instruction) return;
    if (editingRule?.kind === ruleKind && editingRule.instruction === instruction) {
      setEditingRule(null);
      setRule("");
      return;
    }
    setPermissionError(null);
    void (async () => {
      if (!window.openteam) throw new Error("OpenTeam permission settings are unavailable");
      let value = await window.openteam.permissions.addRule({
        kind: ruleKind,
        instruction,
      });
      if (editingRule) {
        value = await window.openteam.permissions.removeRule(editingRule);
      }
      return value;
    })()
      .then((value) => {
        setPermissions(value);
        setEditingRule(null);
        setRule("");
      })
      .catch((error) =>
        setPermissionError(clientErrorMessage(error, "Could not update permissions"))
      );
  };

  const removeRule = (kind: "allow" | "block", instruction: string) => {
    setPermissionError(null);
    if (editingRule?.kind === kind && editingRule.instruction === instruction) {
      setEditingRule(null);
      setRule("");
    }
    void window.openteam?.permissions
      .removeRule({ kind, instruction })
      .then(setPermissions)
      .catch((error) =>
        setPermissionError(clientErrorMessage(error, "Could not update permissions"))
      );
  };

  const editRule = (kind: "allow" | "block", instruction: string) => {
    setEditingRule({ kind, instruction });
    setRuleKind(kind);
    setRule(instruction);
  };

  return (
    <>
      <SectionLabel>Bot</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["auto-review"]}
          control={
            <InteractiveSwitch
              checked={permissions?.autoReview.isEnabled ?? true}
              disabled={!permissions}
              onChange={(autoReviewEnabled) => updatePermissions({ autoReviewEnabled })}
            />
          }
          description="OpenTeam checks each action before it runs and asks you first when needed. Add rules to customize what it can do automatically."
          title="Auto-review"
        />
        <div className="border-t border-black/[0.065] py-3.5 dark:border-white/[0.07]">
          <div className="text-[13px] leading-[18px]">Auto-review Rules</div>
          <div className="mb-4 text-[12.5px] leading-[17px] text-foreground-secondary">
            Write one short, natural-language rule for each action. "Ask first" takes priority if
            rules conflict.
          </div>
          <label className="block text-[12.5px] leading-[18px]" htmlFor="settings-rule-action">
            When OpenTeam wants to:
          </label>
          <input
            className="mt-1 h-9 w-full rounded-[8px] border border-black/[0.09] bg-background px-2.5 text-[13px] outline-none placeholder:text-foreground-tertiary dark:border-white/[0.1]"
            id="settings-rule-action"
            placeholder="e.g. reply to emails for me"
            maxLength={1000}
            onChange={(event) => setRule(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addRule();
            }}
            value={rule}
          />
          <div className="mt-2.5 text-[12.5px] leading-[18px]">It should:</div>
          <div className="mt-1 flex items-center justify-between gap-4">
            <Select
              onValueChange={(value) => setRuleKind(value as "allow" | "block")}
              value={ruleKind}
            >
              <SelectTrigger
                aria-label="Rule behavior"
                className="h-8 rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">Allow automatically</SelectItem>
                <SelectItem value="block">Ask first</SelectItem>
              </SelectContent>
            </Select>
            <button
              className="inline-flex h-8 items-center rounded-[9px] bg-black/[0.08] px-3 text-[13px] text-foreground disabled:text-foreground-tertiary dark:bg-white/[0.09]"
              disabled={!permissions || !rule.trim()}
              onClick={addRule}
              type="button"
            >
              Add rule
            </button>
          </div>
          {permissions &&
          permissions.autoReview.allowInstructions.length +
            permissions.autoReview.blockInstructions.length >
            0 ? (
            <div
              aria-label="Auto-review rules"
              className="mt-4 overflow-hidden rounded-[8px] border border-black/[0.07] bg-background/55 dark:border-white/[0.075]"
              role="table"
            >
              <div
                className="grid grid-cols-[minmax(0,1fr)_112px_58px] px-2.5 py-1.5 text-[10.5px] text-foreground-tertiary"
                role="row"
              >
                <span role="columnheader">Action</span>
                <span role="columnheader">Behavior</span>
                <span aria-hidden="true" />
              </div>
              {[
                ...permissions.autoReview.blockInstructions.map((instruction) => ({
                  kind: "block" as const,
                  instruction,
                })),
                ...permissions.autoReview.allowInstructions.map((instruction) => ({
                  kind: "allow" as const,
                  instruction,
                })),
              ].map(({ instruction, kind }, index) => (
                <div
                  className="grid min-h-9 grid-cols-[minmax(0,1fr)_112px_58px] items-center gap-1 border-t border-black/[0.065] px-2.5 py-1.5 text-[12px] dark:border-white/[0.07]"
                  key={`${kind}:${instruction}`}
                  role="row"
                >
                  <span className="min-w-0 break-words pr-2" role="cell">
                    {instruction}
                  </span>
                  <span className="text-foreground-secondary" role="cell">
                    {kind === "block" ? "Ask first" : "Allow automatically"}
                  </span>
                  <span className="flex justify-end gap-0.5" role="cell">
                    <button
                      aria-label={`Edit rule ${index + 1}`}
                      className="grid size-6 place-items-center rounded-[6px] text-foreground-tertiary hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                      onClick={() => editRule(kind, instruction)}
                      type="button"
                    >
                      <Pencil className="size-3" strokeWidth={1.8} />
                    </button>
                    <button
                      aria-label={`Delete rule ${index + 1}`}
                      className="grid size-6 place-items-center rounded-[6px] text-foreground-tertiary hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                      onClick={() => removeRule(kind, instruction)}
                      type="button"
                    >
                      <Trash2 className="size-3" strokeWidth={1.8} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {permissionError ? (
            <div className="mt-3 text-[12px] text-red-600 dark:text-red-400">{permissionError}</div>
          ) : null}
          <div className="mt-5 text-[12.5px] leading-[17px] text-foreground-secondary">
            These rules apply only to you. Built-in safety checks always apply.
          </div>
        </div>
      </SettingsGroup>
    </>
  );
}
