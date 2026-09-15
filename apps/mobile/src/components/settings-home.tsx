import type { OpenTeamAuthUser } from "@openteam/client-core/auth";
import { SymbolView } from "expo-symbols";
import type React from "react";
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import {
  NativeSettingsList,
  NativeToolbarButton,
  type NativeSettingsSection,
} from "./native-controls";
import { accountInitials, accountName } from "../account-display";
import type { AccentPreference, AppearancePreference } from "../appearance";
import type { Theme } from "../theme";
import { useTheme } from "../theme";

type NotificationPermission = "loading" | "not_determined" | "granted" | "denied" | "unavailable";

function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <NativeToolbarButton name="xmark" label="Close settings" onPress={onPress} symbolSize={17} />
  );
}

function Chevron({ theme }: { theme: Theme }) {
  return <SymbolView name="chevron.right" size={14} tintColor={theme.textFaint} weight="medium" />;
}

function Row({
  children,
  description,
  first = false,
  last = false,
  onPress,
  title,
  trailing,
}: {
  children?: React.ReactNode;
  description?: string;
  first?: boolean;
  last?: boolean;
  onPress?: () => void;
  title: string;
  trailing?: React.ReactNode;
}) {
  const theme = useTheme();
  const content = (
    <>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>{title}</Text>
        {description ? (
          <Text style={[styles.rowDescription, { color: theme.textMuted }]}>{description}</Text>
        ) : null}
        {children}
      </View>
      {trailing ?? (onPress ? <Chevron theme={theme} /> : null)}
    </>
  );
  const rowStyle = [
    styles.row,
    { borderBottomColor: theme.separator },
    first && styles.firstRow,
    last && styles.lastRow,
  ];
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [rowStyle, pressed && { backgroundColor: theme.surfacePressed }]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={rowStyle}>{content}</View>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={[styles.card, { backgroundColor: theme.surfaceElevated, borderColor: theme.border }]}
    >
      {children}
    </View>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.sectionLabel, { color: theme.textFaint }]}>{children}</Text>;
}

const initialsFor = accountInitials;

const appearanceName = (preference: AppearancePreference, accent: AccentPreference): string => {
  const mode = preference === "system" ? "System" : preference === "light" ? "Day" : "Night";
  return `${mode} · ${accent === "blue" ? "Blue" : "Black"}`;
};

export function SettingsHome({
  accent,
  appVersion,
  appearance,
  authRequired,
  hapticsEnabled,
  hapticsDisabled,
  notificationPermission,
  onAccount,
  onAppearance,
  onAutoReviewInfo,
  onClose,
  onFeedback,
  onNotifications,
  onPlugins,
  onSignOut,
  onSystemPreferenceInfo,
  onToggleHaptics,
  user,
}: {
  accent: AccentPreference;
  appVersion: string;
  appearance: AppearancePreference;
  authRequired: boolean;
  hapticsEnabled: boolean;
  hapticsDisabled: boolean;
  notificationPermission: NotificationPermission;
  onAccount: () => void;
  onAppearance: () => void;
  onAutoReviewInfo: () => void;
  onClose: () => void;
  onFeedback: () => void;
  onNotifications: () => void;
  onPlugins: () => void;
  onSignOut: () => void;
  onSystemPreferenceInfo: (setting: "language" | "timezone") => void;
  onToggleHaptics: (enabled: boolean) => void;
  user: OpenTeamAuthUser | null;
}) {
  const theme = useTheme();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "System";
  const profileName = accountName(user);
  const profileDetail = user || authRequired ? "Username and password" : "No sign-in required";
  const notificationsOn = notificationPermission === "granted";
  const openHelp = () => void Linking.openURL("https://github.com/raghavpillai/openteam#readme");
  if (NativeSettingsList) {
    const sections: NativeSettingsSection[] = [
      {
        rows: [
          {
            id: "account",
            title: profileName,
            subtitle: profileDetail,
            kind: "profile",
            initials: accountInitials(user),
          },
        ],
      },
      {
        rows: [
          {
            id: "plugins",
            title: "Plugins",
            subtitle: "Tools and skills for OpenTeam",
            symbol: "puzzlepiece.extension",
          },
        ],
      },
      {
        title: "Bot",
        rows: [
          {
            id: "review",
            title: "Auto-review Rules",
            detail: "Desktop managed",
            symbol: "checkmark.shield",
          },
          { id: "timezone", title: "Time Zone", detail: timeZone, symbol: "globe" },
        ],
      },
      {
        rows: [
          {
            id: "notifications",
            title: "Notifications",
            symbol: "bell",
            kind: "toggle",
            value: notificationsOn,
            disabled:
              notificationPermission === "loading" || notificationPermission === "unavailable",
          },
          {
            id: "appearance",
            title: "Appearance",
            detail: appearanceName(appearance, accent),
            symbol: "circle.lefthalf.filled",
          },
          { id: "language", title: "Language", detail: "System", symbol: "character.bubble" },
          {
            id: "haptics",
            title: "App haptics",
            symbol: "hand.tap",
            kind: "toggle",
            value: hapticsEnabled,
            disabled: hapticsDisabled,
          },
        ],
      },
      {
        rows: [
          { id: "help", title: "Help Center", symbol: "questionmark.circle" },
          { id: "feedback", title: "Send Feedback", symbol: "bubble.left" },
        ],
      },
      ...(authRequired
        ? [{ rows: [{ id: "signout", title: "Sign Out", destructive: true }] }]
        : []),
      { footer: `OpenTeam ${appVersion}`, rows: [] },
    ];
    return (
      <NativeSettingsList
        dark={theme.dark}
        sections={sections}
        style={{ flex: 1 }}
        onAction={({ nativeEvent: { id, value } }) => {
          switch (id) {
            case "close":
              onClose();
              break;
            case "account":
              onAccount();
              break;
            case "plugins":
              onPlugins();
              break;
            case "review":
              onAutoReviewInfo();
              break;
            case "timezone":
            case "language":
              onSystemPreferenceInfo(id);
              break;
            case "notifications":
              onNotifications();
              break;
            case "appearance":
              onAppearance();
              break;
            case "haptics":
              if (typeof value === "boolean") onToggleHaptics(value);
              break;
            case "help":
              openHelp();
              break;
            case "feedback":
              onFeedback();
              break;
            case "signout":
              onSignOut();
              break;
          }
        }}
      />
    );
  }
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      keyboardDismissMode="interactive"
      showsVerticalScrollIndicator={false}
      style={styles.scroll}
    >
      <View style={styles.header}>
        <CloseButton onPress={onClose} />
      </View>

      <Card>
        <Pressable
          accessibilityLabel="Account and connection settings"
          accessibilityRole="button"
          onPress={onAccount}
          style={({ pressed }) => [
            styles.profileRow,
            { borderBottomColor: theme.separator },
            pressed && { backgroundColor: theme.surfacePressed },
          ]}
        >
          <View style={[styles.avatar, { backgroundColor: theme.surfacePressed }]}>
            <Text style={[styles.avatarText, { color: theme.textMuted }]}>{initialsFor(user)}</Text>
          </View>
          <View style={styles.profileCopy}>
            <Text numberOfLines={1} style={[styles.profileName, { color: theme.text }]}>
              {profileName}
            </Text>
            <Text numberOfLines={1} style={[styles.profileDetail, { color: theme.textMuted }]}>
              {profileDetail}
            </Text>
          </View>
          <Chevron theme={theme} />
        </Pressable>
      </Card>

      <View style={styles.groupGap} />
      <Card>
        <Row
          description="Tools and skills for OpenTeam"
          first
          last
          onPress={onPlugins}
          title="Plugins"
        />
      </Card>

      <SectionLabel>Bot</SectionLabel>
      <Card>
        <Row
          first
          onPress={onAutoReviewInfo}
          title="Auto-review Rules"
          description="Managed on your computer"
        />
        <Row
          last
          onPress={() => onSystemPreferenceInfo("timezone")}
          title="Time Zone"
          trailing={
            <Text
              numberOfLines={1}
              style={[styles.value, styles.timeZone, { color: theme.textMuted }]}
            >
              {timeZone}
            </Text>
          }
        />
      </Card>

      <View style={styles.groupGap} />
      <Card>
        <Row
          first
          title="Notifications"
          trailing={
            <Switch
              accessibilityLabel="Notifications"
              disabled={
                notificationPermission === "loading" || notificationPermission === "unavailable"
              }
              onValueChange={onNotifications}
              style={styles.compactSwitch}
              trackColor={{ false: theme.surfacePressed, true: "#30D158" }}
              value={notificationsOn}
            />
          }
        />
        <Row
          onPress={onAppearance}
          title="Appearance"
          trailing={
            <View style={styles.valueWithChevron}>
              <Text style={[styles.value, { color: theme.textMuted }]}>
                {appearanceName(appearance, accent)}
              </Text>
              <Chevron theme={theme} />
            </View>
          }
        />
        <Row
          onPress={() => onSystemPreferenceInfo("language")}
          title="Language"
          trailing={
            <View style={styles.valueWithChevron}>
              <Text style={[styles.value, { color: theme.textMuted }]}>System</Text>
              <Chevron theme={theme} />
            </View>
          }
        />
        <Row
          last
          title="App haptics"
          description="Feedback for gestures and important actions. System controls follow iOS settings."
          trailing={
            <Switch
              accessibilityLabel="App haptics"
              disabled={hapticsDisabled}
              value={hapticsEnabled}
              onValueChange={onToggleHaptics}
              trackColor={{ true: theme.accent }}
            />
          }
        />
      </Card>

      <View style={styles.groupGap} />
      <Card>
        <Row first last onPress={openHelp} title="Help Center" />
      </Card>

      <View style={styles.groupGap} />
      <Card>
        <Row first last onPress={onFeedback} title="Send Feedback" />
      </Card>

      {authRequired ? (
        <>
          <View style={styles.groupGap} />
          <Card>
            <Row first last onPress={onSignOut} title="Sign Out" trailing={<View />} />
          </Card>
        </>
      ) : null}

      <View style={styles.about}>
        <Image
          source={
            theme.dark
              ? require("../../assets/openteam-icon-dark.png")
              : require("../../assets/openteam-icon.png")
          }
          style={styles.appIcon}
        />
        <Text style={[styles.appName, { color: theme.text }]}>OpenTeam</Text>
        <Text style={[styles.appVersion, { color: theme.textMuted }]}>{appVersion}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 14, paddingBottom: 72 },
  header: { height: 84, justifyContent: "flex-start", paddingTop: 16 },
  card: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  groupGap: { height: 24 },
  sectionLabel: { marginLeft: 16, marginTop: 26, marginBottom: 6, fontSize: 13, lineHeight: 17 },
  row: {
    minHeight: 44,
    paddingHorizontal: 15,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  firstRow: { borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  lastRow: { borderBottomWidth: 0, borderBottomLeftRadius: 18, borderBottomRightRadius: 18 },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 16, lineHeight: 21, fontWeight: "400" },
  rowDescription: { marginTop: 3, maxWidth: 300, fontSize: 13, lineHeight: 17 },
  valueWithChevron: { maxWidth: "62%", flexDirection: "row", alignItems: "center", gap: 9 },
  value: { fontSize: 15, lineHeight: 20 },
  timeZone: { maxWidth: "56%" },
  profileRow: {
    minHeight: 60,
    paddingHorizontal: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 15, lineHeight: 19, fontWeight: "700" },
  compactSwitch: { transform: [{ translateX: 4 }, { scale: 0.88 }] },
  profileCopy: { flex: 1, minWidth: 0 },
  profileName: { fontSize: 16, lineHeight: 21, fontWeight: "500" },
  profileDetail: { marginTop: 1, fontSize: 13, lineHeight: 17 },
  about: { alignItems: "center", paddingTop: 52, paddingBottom: 22 },
  appIcon: { width: 43, height: 43, borderRadius: 12 },
  appName: { marginTop: 13, fontSize: 16, lineHeight: 21, fontWeight: "500" },
  appVersion: { marginTop: 2, fontSize: 12, lineHeight: 16 },
});
