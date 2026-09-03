import type { BotView, RoutineView } from "@openbot/contracts";
import {
  BOT_AVATAR_SHAPES,
  type BotAvatarShape,
  DEFAULT_BOT_AVATAR,
  normalizeBotAvatarShape,
} from "@openbot/contracts/bot-avatar";
import { routineScheduleSummary as routineSummary } from "@openbot/product-core/routines";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { BotMark } from "./bot-mark";
import { IconButton } from "./icon-button";

const PROFILE_COLORS = [
  "#ffffff",
  "#a47952",
  "#f23d52",
  "#ff7a1a",
  "#ff9e12",
  "#10b972",
  "#27baae",
  "#4b8efb",
  "#925df2",
  "#ef479b",
  "#878787",
] as const;

interface BotProfileScreenProps {
  bot: BotView;
  routines: RoutineView[];
  routinesLoading: boolean;
  error: string | null;
  onBack: () => void;
  onMore: () => void;
  onOpenInstructions: () => void;
  onOpenRoutine: (routine: RoutineView) => void;
  onSaveIdentity: (name: string, title: string) => Promise<void>;
  onUpdateAvatar: (icon: BotAvatarShape, color: string) => Promise<void>;
}

function SelectionRing({ selected, children }: { selected: boolean; children: React.ReactNode }) {
  return (
    <View style={[styles.selectionRing, selected && styles.selectionRingSelected]}>{children}</View>
  );
}

function RoutineRow({
  routine,
  first,
  last,
  onOpen,
}: {
  routine: RoutineView;
  first: boolean;
  last: boolean;
  onOpen: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={`Open ${routine.name} routine`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.routineRow,
        {
          backgroundColor: theme.dark ? "#1e1e1e" : theme.surfaceElevated,
          borderBottomColor: last ? "transparent" : theme.separator,
        },
        first && styles.routineRowFirst,
        last && styles.routineRowLast,
        pressed && styles.pressed,
      ]}
    >
      <SymbolView
        name="clock.arrow.circlepath"
        size={18}
        tintColor={theme.danger}
        weight="medium"
      />
      <View style={styles.routineCopy}>
        <Text numberOfLines={1} style={[styles.routineName, { color: theme.text }]}>
          {routine.name}
        </Text>
        <Text numberOfLines={1} style={[styles.routineSchedule, { color: theme.textMuted }]}>
          {routineSummary(routine)}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={15} tintColor={theme.textFaint} weight="medium" />
    </Pressable>
  );
}

export function BotProfileScreen({
  bot,
  routines,
  routinesLoading,
  error,
  onBack,
  onMore,
  onOpenInstructions,
  onOpenRoutine,
  onSaveIdentity,
  onUpdateAvatar,
}: BotProfileScreenProps) {
  const theme = useTheme();
  const canvas = theme.dark ? "#111111" : theme.background;
  const panel = theme.dark ? "#1e1e1e" : theme.surfaceElevated;
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [shape, setShape] = useState<BotAvatarShape>(normalizeBotAvatarShape(bot.icon));
  const [color, setColor] = useState(bot.color);
  const [avatarSaving, setAvatarSaving] = useState(false);

  useEffect(() => {
    setName(bot.name);
    setTitle(bot.title);
    setShape(normalizeBotAvatarShape(bot.icon));
    setColor(bot.color);
  }, [bot.color, bot.icon, bot.name, bot.title]);

  const commitIdentity = () => {
    const nextName = name.trim();
    const nextTitle = title.trim();
    if (!nextName) {
      setName(bot.name);
      return;
    }
    if (nextName === bot.name && nextTitle === bot.title) return;
    void onSaveIdentity(nextName, nextTitle);
  };

  const commitAvatar = async (nextShape: BotAvatarShape, nextColor: string) => {
    if (avatarSaving || (nextShape === shape && nextColor === color)) return;
    const previousShape = shape;
    const previousColor = color;
    setShape(nextShape);
    setColor(nextColor);
    setAvatarSaving(true);
    try {
      await onUpdateAvatar(nextShape, nextColor);
    } catch {
      setShape(previousShape);
      setColor(previousColor);
    } finally {
      setAvatarSaving(false);
    }
  };

  const header = (
    <>
      <View style={styles.avatarWrap}>
        <BotMark color={color} icon={shape} showFace={false} size={98} />
      </View>

      <View style={[styles.identityCard, { backgroundColor: panel }]}>
        <TextInput
          accessibilityLabel="Bot name"
          maxLength={80}
          onBlur={commitIdentity}
          onChangeText={setName}
          returnKeyType="done"
          selectTextOnFocus
          style={[styles.nameInput, { color: theme.text }]}
          value={name}
        />
        <View style={[styles.identityDivider, { backgroundColor: theme.separator }]} />
        <TextInput
          accessibilityLabel="Bot title"
          maxLength={120}
          onBlur={commitIdentity}
          onChangeText={setTitle}
          placeholder="Add a title"
          placeholderTextColor={theme.textFaint}
          returnKeyType="done"
          selectTextOnFocus
          style={[styles.titleInput, { color: theme.textMuted }]}
          value={title}
        />
      </View>

      <Text style={[styles.sectionLabel, styles.characterLabel, { color: theme.textFaint }]}>
        Character
      </Text>
      <View style={[styles.characterCard, { backgroundColor: panel }]}>
        <View style={styles.colorGrid}>
          {PROFILE_COLORS.map((candidate) => (
            <Pressable
              accessibilityLabel={`Use ${candidate} color`}
              accessibilityRole="radio"
              accessibilityState={{ checked: candidate.toLowerCase() === color.toLowerCase() }}
              disabled={avatarSaving}
              key={candidate}
              onPress={() => void commitAvatar(shape, candidate)}
              style={({ pressed }) => [styles.colorChoice, pressed && styles.pressed]}
            >
              <SelectionRing selected={candidate.toLowerCase() === color.toLowerCase()}>
                <View style={[styles.colorDot, { backgroundColor: candidate }]} />
              </SelectionRing>
            </Pressable>
          ))}
        </View>
        <View style={[styles.panelDivider, { backgroundColor: theme.separator }]} />
        <View style={styles.shapeRow}>
          {BOT_AVATAR_SHAPES.map((candidate) => (
            <Pressable
              accessibilityLabel={`Use ${candidate} shape`}
              accessibilityRole="radio"
              accessibilityState={{ checked: candidate === shape }}
              disabled={avatarSaving}
              key={candidate}
              onPress={() => void commitAvatar(candidate, color)}
              style={({ pressed }) => [styles.shapeChoice, pressed && styles.pressed]}
            >
              <SelectionRing selected={candidate === shape}>
                <BotMark color={color} icon={candidate} showFace={false} size={24} />
              </SelectionRing>
            </Pressable>
          ))}
        </View>
        <View style={[styles.panelDivider, { backgroundColor: theme.separator }]} />
        <Pressable
          accessibilityRole="button"
          disabled={avatarSaving}
          onPress={() => void commitAvatar(DEFAULT_BOT_AVATAR.shape, DEFAULT_BOT_AVATAR.color)}
          style={({ pressed }) => [styles.resetRow, pressed && styles.pressed]}
        >
          <Text style={[styles.resetText, { color: theme.accent }]}>Reset to default</Text>
        </Pressable>
      </View>
      <Text style={[styles.helper, { color: theme.textFaint }]}>
        How this Bot&apos;s mark looks everywhere
      </Text>

      <Pressable
        accessibilityRole="button"
        onPress={onOpenInstructions}
        style={({ pressed }) => [
          styles.disclosure,
          { backgroundColor: panel },
          pressed && styles.pressed,
        ]}
      >
        <SymbolView name="doc.text" size={18} tintColor={theme.textMuted} weight="regular" />
        <Text style={[styles.disclosureText, { color: theme.text }]}>Instructions</Text>
        <SymbolView name="chevron.right" size={15} tintColor={theme.textFaint} weight="medium" />
      </Pressable>

      <View style={styles.routinesHeading}>
        <Text style={[styles.sectionLabel, { color: theme.textFaint }]}>Routines</Text>
        {routinesLoading ? <ActivityIndicator color={theme.textFaint} size="small" /> : null}
      </View>
      {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
    </>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: canvas }]}>
      <View style={styles.nav}>
        <IconButton
          label="Back"
          name="chevron.left"
          onPress={onBack}
          size={40}
          symbolSize={19}
          tone="surface"
        />
        <IconButton
          label="More"
          name="ellipsis"
          onPress={onMore}
          size={40}
          symbolSize={19}
          tone="surface"
        />
      </View>
      <FlatList
        contentContainerStyle={styles.content}
        data={routines}
        keyExtractor={(routine) => routine.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          routinesLoading ? null : (
            <Text style={[styles.empty, { backgroundColor: panel, color: theme.textMuted }]}>
              No routines
            </Text>
          )
        }
        ListFooterComponent={<View style={styles.footerSpace} />}
        ListHeaderComponent={header}
        renderItem={({ item, index }) => (
          <RoutineRow
            first={index === 0}
            last={index === routines.length - 1}
            onOpen={() => onOpenRoutine(item)}
            routine={item}
          />
        )}
        style={styles.list}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  nav: {
    height: 44,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  list: { flex: 1 },
  content: { paddingHorizontal: 21, paddingTop: 12 },
  avatarWrap: { height: 86, alignItems: "center", justifyContent: "center" },
  identityCard: {
    height: 92,
    marginTop: 14,
    borderRadius: 16,
    overflow: "hidden",
  },
  nameInput: {
    height: 48,
    paddingHorizontal: 18,
    paddingVertical: 0,
    textAlign: "center",
    fontSize: 20,
    lineHeight: 25,
    fontWeight: "700",
  },
  identityDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
  titleInput: {
    flex: 1,
    paddingHorizontal: 18,
    paddingVertical: 0,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 18,
  },
  sectionLabel: { marginLeft: 16, fontSize: 13, lineHeight: 18 },
  characterLabel: { marginTop: 30, marginBottom: 8 },
  characterCard: { height: 218, borderRadius: 16, overflow: "hidden" },
  colorGrid: {
    height: 103,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    flexWrap: "wrap",
    alignContent: "center",
  },
  colorChoice: { width: 53, height: 40, alignItems: "center", justifyContent: "center" },
  selectionRing: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  selectionRingSelected: { borderColor: "#5d5d61", backgroundColor: "#2b2b2d" },
  colorDot: { width: 24, height: 24, borderRadius: 12 },
  panelDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
  shapeRow: {
    height: 64,
    paddingHorizontal: 5,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  shapeChoice: { width: 39, height: 44, alignItems: "center", justifyContent: "center" },
  resetRow: { flex: 1, paddingHorizontal: 16, justifyContent: "center" },
  resetText: { fontSize: 14, lineHeight: 19 },
  helper: { marginTop: 9, marginLeft: 16, fontSize: 13, lineHeight: 18 },
  disclosure: {
    height: 45,
    marginTop: 14,
    borderRadius: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  disclosureText: { flex: 1, fontSize: 16, lineHeight: 21 },
  routinesHeading: {
    height: 55,
    paddingTop: 0,
    paddingRight: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  routineRow: {
    height: 62,
    paddingHorizontal: 17,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  routineRowFirst: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  routineRowLast: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  routineCopy: { flex: 1, gap: 1 },
  routineName: { fontSize: 16, lineHeight: 20 },
  routineSchedule: { fontSize: 13, lineHeight: 17 },
  empty: { padding: 18, borderRadius: 14, overflow: "hidden", textAlign: "center", fontSize: 14 },
  error: { marginBottom: 8, textAlign: "center", fontSize: 13 },
  footerSpace: { height: 36 },
  pressed: { opacity: 0.72 },
});
