import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";
import { GlassSurface } from "./glass-surface";

type MenuMode = "root" | "move" | "more";

export interface MoveDestination {
  id: string | null;
  name: string;
}

interface MenuRowProps {
  destructive?: boolean;
  icon: SymbolViewProps["name"];
  label: string;
  onPress: () => void;
  trailing?: "chevron" | "expanded";
}

function MenuRow({ destructive = false, icon, label, onPress, trailing }: MenuRowProps) {
  const theme = useTheme();
  const tint = destructive ? "#ff4d59" : theme.text;
  return (
    <Pressable
      accessibilityRole="menuitem"
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.menuRow,
        pressed && {
          backgroundColor: theme.dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)",
        },
      ]}
    >
      <SymbolView name={icon} size={18} tintColor={tint} weight="regular" />
      <Text numberOfLines={1} style={[styles.menuLabel, { color: tint }]}>
        {label}
      </Text>
      {trailing ? (
        <SymbolView
          name={trailing === "expanded" ? "chevron.down" : "chevron.right"}
          size={13}
          tintColor={theme.text}
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function Separator() {
  const theme = useTheme();
  return <View style={[styles.separator, { backgroundColor: theme.separator }]} />;
}

function MenuCard({ children, top }: { children: React.ReactNode; top: number }) {
  const theme = useTheme();
  return (
    <GlassSurface
      fallbackColor={theme.dark ? "rgba(50,50,50,0.98)" : "rgba(245,245,245,0.98)"}
      style={[
        styles.card,
        {
          top,
          borderColor: theme.dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)",
          shadowColor: "#000",
        },
      ]}
    >
      {children}
    </GlassSurface>
  );
}

export function ConversationContextMenu({
  currentSectionId,
  isPinned,
  isUnread,
  moveDestinations,
  onAskSiri,
  onClose,
  onCopyId,
  onDelete,
  onHide,
  onMove,
  onNewSection,
  onTogglePinned,
  onToggleUnread,
  visible,
}: {
  currentSectionId: string | null;
  isPinned: boolean;
  isUnread: boolean;
  moveDestinations: readonly MoveDestination[];
  onAskSiri: () => void;
  onClose: () => void;
  onCopyId: () => void;
  onDelete: () => void;
  onHide: () => void;
  onMove: (sectionId: string | null) => void;
  onNewSection: () => void;
  onTogglePinned: () => void;
  onToggleUnread: () => void;
  visible: boolean;
}) {
  const [mode, setMode] = useState<MenuMode>("root");

  const closeAfter = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <Modal
      animationType="fade"
      onDismiss={() => setMode("root")}
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <Pressable
          accessibilityLabel="Close conversation menu"
          onPress={onClose}
          style={styles.backdrop}
        />

        <MenuCard top={176}>
          <MenuRow
            icon="bubble.left"
            label={isUnread ? "Mark Read" : "Mark Unread"}
            onPress={() => closeAfter(onToggleUnread)}
          />
          <MenuRow
            icon="pin"
            label={isPinned ? "Unpin" : "Pin"}
            onPress={() => closeAfter(onTogglePinned)}
          />
          <MenuRow
            icon="folder"
            label="Move to"
            onPress={() => setMode(mode === "move" ? "root" : "move")}
            trailing={mode === "move" ? "expanded" : "chevron"}
          />
          <MenuRow destructive icon="eye.slash" label="Hide" onPress={() => closeAfter(onHide)} />
          <MenuRow
            icon="ellipsis"
            label="More"
            onPress={() => setMode(mode === "more" ? "root" : "more")}
            trailing={mode === "more" ? "expanded" : "chevron"}
          />
          <Separator />
          <MenuRow icon="waveform.circle" label="Ask Siri" onPress={() => closeAfter(onAskSiri)} />
        </MenuCard>

        {mode === "move" ? (
          <MenuCard top={232}>
            <MenuRow
              icon="folder"
              label="Move to"
              onPress={() => setMode("root")}
              trailing="expanded"
            />
            <Separator />
            {moveDestinations.map((destination) => (
              <MenuRow
                icon={destination.id === currentSectionId ? "folder.fill" : "folder"}
                key={destination.id ?? "unassigned"}
                label={destination.name}
                onPress={() => closeAfter(() => onMove(destination.id))}
              />
            ))}
            <MenuRow
              icon="folder.badge.plus"
              label="New Section"
              onPress={() => closeAfter(onNewSection)}
            />
          </MenuCard>
        ) : null}

        {mode === "more" ? (
          <MenuCard top={270}>
            <MenuRow
              icon="ellipsis"
              label="More"
              onPress={() => setMode("root")}
              trailing="expanded"
            />
            <Separator />
            <MenuRow icon="doc.on.doc" label="Copy ID" onPress={() => closeAfter(onCopyId)} />
            <MenuRow destructive icon="trash" label="Delete" onPress={() => closeAfter(onDelete)} />
          </MenuCard>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  backdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  card: {
    position: "absolute",
    left: 18,
    width: 228,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    paddingVertical: 4,
    shadowOpacity: 0.34,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 24,
  },
  menuRow: {
    height: 41,
    paddingHorizontal: 25,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  menuLabel: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: "400" },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 18,
    marginVertical: 3,
  },
});
