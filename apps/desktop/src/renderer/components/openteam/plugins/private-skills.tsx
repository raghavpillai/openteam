import type {
  PluginManagementView,
  PluginPrivateSkillView,
} from "@openteam/contracts/plugin-management";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { inputClass, PluginButton, PluginField, usePluginOperation } from "./plugin-ui";

export function PrivateSkills({
  data,
  refresh,
}: {
  data: PluginManagementView;
  refresh: () => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<PluginPrivateSkillView | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState("{}");
  const [enabledBotIds, setEnabledBotIds] = useState<string[]>([]);
  const [bots, setBots] = useState<Array<{ id: string; name: string }>>([]);
  const [armed, setArmed] = useState(false);
  const operation = usePluginOperation(refresh);
  useEffect(() => {
    void operation.run(async () => setBots(await api.bots()));
  }, []);
  const edit = (skill: PluginPrivateSkillView | null) => {
    setSelected(skill);
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setBody(skill?.body ?? "");
    setFiles(JSON.stringify(skill?.files ?? {}, null, 2));
    setEnabledBotIds(skill?.enabledBotIds ?? []);
    setEditing(true);
    setArmed(false);
  };
  return (
    <div className="grid gap-5">
      {operation.feedback}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">Private skills</h3>
          <p className="text-sm text-foreground-secondary">
            Instructions and supporting files stored on your server. Choose which Bots can use each
            skill.
          </p>
        </div>
        <PluginButton onClick={() => edit(null)}>Create skill</PluginButton>
      </div>
      <div className="grid gap-2">
        {data.skills.map((skill) => (
          <button
            type="button"
            onClick={() => edit(skill)}
            key={skill.id}
            className="rounded-xl border border-black/10 p-4 text-left dark:border-white/10"
          >
            <p className="font-medium">{skill.name}</p>
            <p className="text-sm text-foreground-secondary">
              {skill.description} · {skill.enabledBotIds.length} Bots
            </p>
          </button>
        ))}
        {!data.skills.length && !editing && (
          <p className="py-8 text-center text-sm text-foreground-secondary">
            Create a skill or import a SKILL.md file to get started.
          </p>
        )}
      </div>
      <label className="cursor-pointer text-sm text-blue-600 underline">
        Import SKILL.md
        <input
          hidden
          type="file"
          accept=".md"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file)
              void operation.run(async () => {
                const text = await file.text();
                edit(null);
                const { readSkillImport } = await import("./skill-import");
                const parsed = readSkillImport(text, file.name.replace(/\.md$/, ""));
                setName(parsed.name);
                setDescription(parsed.description);
                setBody(parsed.body);
              });
            event.target.value = "";
          }}
        />
      </label>
      {editing && (
        <>
          <PluginField label="Skill name">
            <input
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </PluginField>
          <PluginField label="When to use it">
            <input
              className={inputClass}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </PluginField>
          <PluginField label="Instructions">
            <textarea
              className={`${inputClass} min-h-52`}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </PluginField>
          <details>
            <summary className="cursor-pointer text-sm">Supporting files</summary>
            <PluginField
              label="Relative file paths and text content"
              help='For example: {"references/style.md":"Your reference text"}'
            >
              <textarea
                className={`${inputClass} mt-3 font-mono text-xs`}
                rows={5}
                value={files}
                onChange={(event) => setFiles(event.target.value)}
              />
            </PluginField>
          </details>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Available to Bots</legend>
            {bots.map((bot) => (
              <label className="flex gap-2 text-sm" key={bot.id}>
                <input
                  type="checkbox"
                  checked={enabledBotIds.includes(bot.id)}
                  onChange={(event) =>
                    setEnabledBotIds(
                      event.target.checked
                        ? [...enabledBotIds, bot.id]
                        : enabledBotIds.filter((id) => id !== bot.id)
                    )
                  }
                />
                {bot.name}
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <PluginButton
              primary
              disabled={operation.busy || !name.trim()}
              onClick={() =>
                void operation.run(async () => {
                  await api.savePluginSkill(selected?.id ?? null, {
                    name,
                    description,
                    body,
                    files: JSON.parse(files),
                    enabledBotIds,
                  });
                  setEditing(false);
                }, "Skill saved.")
              }
            >
              Save skill
            </PluginButton>
            <PluginButton onClick={() => setEditing(false)}>Cancel</PluginButton>
            {selected && (
              <PluginButton
                disabled={operation.busy}
                onClick={() =>
                  armed
                    ? void operation.run(async () => {
                        await api.deletePluginSkill(selected.id);
                        setEditing(false);
                      })
                    : setArmed(true)
                }
              >
                {armed ? "Confirm delete skill" : "Delete skill"}
              </PluginButton>
            )}
          </div>
        </>
      )}
    </div>
  );
}
