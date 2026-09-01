import type { OpenBotAuthUser } from "@openbot/client-core/auth";
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
import type { AccentPreference, AppearancePreference } from "../appearance";
import type { Theme } from "../theme";
import { useTheme } from "../theme";

type NotificationPermission = "loading" | "not_determined" | "granted" | "denied" | "unavailable";

function CloseButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel="Close settings"
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.closeButton,
        { backgroundColor: theme.surfacePressed, borderColor: theme.border },
        pressed && styles.pressed,
      ]}
    >
      <SymbolView name="xmark" size={20} tintColor={theme.text} weight="medium" />
    </Pressable>
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

const initialsFor = (user: OpenBotAuthUser | null): string => {
  const source = user?.name || user?.email || "OpenBot";
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join("");
};

const appearanceName = (preference: AppearancePreference, accent: AccentPreference): string => {
  const mode = preference === "system" ? "System" : preference === "light" ? "Day" : "Night";
  return `${mode} · ${accent === "blue" ? "Blue" : "Black"}`;
};

export function SettingsHome({
  accent,
  appVersion,
  appearance,
  authRequired,
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
  user,
}: {
  accent: AccentPreference;
  appVersion: string;
  appearance: AppearancePreference;
  authRequired: boolean;
  notificationPermission: NotificationPermission;
  onAccount: () => void;
  onAppearance: () => void;
  onAutoReviewInfo: () => void;
  onClose: () => void;
  onFeedback: () => void;
  onNotifications: () => void;
  onPlugins: () => void;
  onSignOut: () => void;
  onSystemPreferenceInfo: (setting: "language" | "haptics" | "timezone") => void;
  user: OpenBotAuthUser | null;
}) {
  const theme = useTheme();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "System";
  const profileName = user?.name || user?.username || "OpenBot owner";
  const profileDetail =
    user?.email || (authRequired ? "Signed in securely" : "Authentication disabled");
  const notificationsOn = notificationPermission === "granted";
  const openHelp = () => void Linking.openURL("https://github.com/raghavpillai/openbot#readme");
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
        <Row
          last
          onPress={onAccount}
          title="Usage"
          trailing={
            <View style={styles.valueWithChevron}>
              <Text style={[styles.value, { color: theme.textMuted }]}>—</Text>
              <Chevron theme={theme} />
            </View>
          }
        />
      </Card>

      <View style={styles.groupGap} />
      <Card>
        <Row
          description="Tools and skills for OpenBot"
          first
          last
          onPress={onPlugins}
          title="Plugins"
        />
      </Card>

      <SectionLabel>Bot</SectionLabel>
      <Card>
        <Row
          description="Require approval for risky shell, MCP, and computer actions."
          first
          title="Auto-review"
          trailing={
            <Switch
              accessibilityLabel="Auto-review information"
              onValueChange={onAutoReviewInfo}
              style={styles.compactSwitch}
              trackColor={{ false: theme.surfacePressed, true: "#30D158" }}
              value
            />
          }
        />
        <Row
          onPress={onAutoReviewInfo}
          title="Auto-review Rules"
          trailing={
            <View style={styles.valueWithChevron}>
              <Text style={[styles.value, { color: theme.textMuted }]}>Desktop managed</Text>
              <Chevron theme={theme} />
            </View>
          }
        />
        <Row
          description="Your Bot’s computer follows this device’s time zone."
          title="Set Time Zone Automatically"
          trailing={
            <Switch
              accessibilityLabel="Automatic time zone information"
              onValueChange={() => onSystemPreferenceInfo("timezone")}
              style={styles.compactSwitch}
              trackColor={{ false: theme.surfacePressed, true: "#30D158" }}
              value
            />
          }
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
          onPress={() => onSystemPreferenceInfo("haptics")}
          title="Haptics"
          trailing={
            <View style={styles.valueWithChevron}>
              <Text style={[styles.value, { color: theme.textMuted }]}>On</Text>
              <Chevron theme={theme} />
            </View>
          }
        />
      </Card>

      <View style={styles.groupGap} />
      <Card>
        <Row first onPress={openHelp} title="Help Center" />
        <Row onPress={openHelp} title="Privacy Policy" />
        <Row last onPress={openHelp} title="Terms of Service" />
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
        <Image source={require("../../assets/openbot-icon-v2.png")} style={styles.appIcon} />
        <Text style={[styles.appName, { color: theme.text }]}>OpenBot</Text>
        <Text style={[styles.appVersion, { color: theme.textMuted }]}>{appVersion}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 14, paddingBottom: 72 },
  header: { height: 84, justifyContent: "flex-start", paddingTop: 16 },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
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
    borderBottomWidth: StyleSheet.hairlineWidth,
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
