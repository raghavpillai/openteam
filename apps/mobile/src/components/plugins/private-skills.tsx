import { Switch, Text, View } from "react-native";

import { Button, Field } from "./plugin-controls";
import type { PluginWorkspaceModel } from "./use-plugin-workspace";
export function PrivateSkills({ model }: { model: PluginWorkspaceModel }) {
  const {
    editSkill,
    busy,
    run,
    importFile,
    management,
    skillEditing,
    skillName,
    setSkillName,
    skillDescription,
    setSkillDescription,
    skillBody,
    setSkillBody,
    skillFiles,
    setSkillFiles,
    bots,
    theme,
    skillBots,
    setSkillBots,
    api,
    skill,
    setSkillEditing,
    confirm,
  } = model;
  return (
    <>
      <Button onPress={() => editSkill(null)}>Create skill</Button>
      <Button disabled={busy} onPress={() => void run(importFile)}>
        Import SKILL.md
      </Button>
      {management?.skills.map((entry) => (
        <Button key={entry.id} onPress={() => editSkill(entry)}>
          {entry.name}
        </Button>
      ))}
      {skillEditing && (
        <>
          <Field label="Skill name" value={skillName} onChange={setSkillName} />
          <Field label="When to use it" value={skillDescription} onChange={setSkillDescription} />
          <Field label="Instructions" value={skillBody} onChange={setSkillBody} multiline />
          <Field
            label="Supporting files (relative path / text JSON)"
            value={skillFiles}
            onChange={setSkillFiles}
            multiline
          />
          {bots.map((bot) => (
            <View key={bot.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: theme.text }}>{bot.name}</Text>
              <Switch
                accessibilityLabel={`Enable skill for ${bot.name}`}
                value={skillBots.includes(bot.id)}
                onValueChange={(enabled) =>
                  setSkillBots(
                    enabled ? [...skillBots, bot.id] : skillBots.filter((id) => id !== bot.id)
                  )
                }
              />
            </View>
          ))}
          <Button
            disabled={busy || !skillName}
            onPress={() =>
              void run(async () => {
                await api((client) =>
                  client.savePluginSkill(skill?.id ?? null, {
                    name: skillName,
                    description: skillDescription,
                    body: skillBody,
                    files: JSON.parse(skillFiles),
                    enabledBotIds: skillBots,
                  })
                );
                setSkillEditing(false);
              }, "Skill saved.")
            }
          >
            Save skill
          </Button>
          {skill && (
            <Button
              disabled={busy}
              onPress={() =>
                confirm("Delete skill", "Remove this skill from all Bots?", async () => {
                  await api((client) => client.deletePluginSkill(skill.id));
                  setSkillEditing(false);
                })
              }
            >
              Delete skill
            </Button>
          )}
        </>
      )}
    </>
  );
}
