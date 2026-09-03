import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";

interface HelpItem {
  icon: SymbolViewProps["name"];
  title: string;
  detail: string;
}

const moving: HelpItem[] = [
  {
    icon: "arrow.up.and.down",
    title: "Scroll",
    detail: "Drag with two fingers.",
  },
  {
    icon: "hand.tap",
    title: "Click and Drag",
    detail: "Tap to click where you tapped. One finger drags.",
  },
  {
    icon: "list.bullet",
    title: "Right-Click",
    detail: "Tap with two fingers, or press and hold.",
  },
  {
    icon: "plus.magnifyingglass",
    title: "Zoom In",
    detail:
      "Pinch to zoom around your fingers. Zoomed in, drag with two fingers to pan, or tap Reset zoom to return.",
  },
];

const typing: HelpItem[] = [
  {
    icon: "keyboard",
    title: "Type",
    detail: "Tap the keyboard button in the bottom bar.",
  },
  {
    icon: "clipboard",
    title: "Copy and Paste",
    detail: "Tap the clipboard button in the bottom bar to paste from this iPhone.",
  },
];

function HelpCard({ items }: { items: HelpItem[] }) {
  const theme = useTheme();
  return (
    <View
      style={[styles.card, { backgroundColor: theme.surfaceElevated, borderColor: theme.border }]}
    >
      {items.map((item, index) => (
        <View
          key={item.title}
          style={[
            styles.item,
            index < items.length - 1 && [
              styles.itemDivider,
              { borderBottomColor: theme.separator },
            ],
          ]}
        >
          <SymbolView name={item.icon} size={20} tintColor={theme.textMuted} weight="regular" />
          <View style={styles.itemCopy}>
            <Text style={[styles.itemTitle, { color: theme.text }]}>{item.title}</Text>
            <Text style={[styles.itemDetail, { color: theme.textMuted }]}>{item.detail}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function ComputerHelpSheet({ onClose, visible }: { onClose: () => void; visible: boolean }) {
  const theme = useTheme();
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdrop}>
        <SafeAreaView
          edges={["bottom"]}
          style={[styles.safe, { backgroundColor: theme.background }]}
        >
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable
                accessibilityLabel="Close computer help"
                accessibilityRole="button"
                onPress={onClose}
                style={({ pressed }) => [
                  styles.close,
                  {
                    backgroundColor: theme.surfacePressed,
                    borderColor: theme.border,
                  },
                  pressed && styles.pressed,
                ]}
              >
                <SymbolView name="xmark" size={20} tintColor={theme.text} weight="medium" />
              </Pressable>
              <Text style={[styles.title, { color: theme.text }]}>Using the Computer</Text>
            </View>

            <Text style={[styles.section, { color: theme.textFaint }]}>Moving Around</Text>
            <HelpCard items={moving} />

            <Text style={[styles.section, { color: theme.textFaint }]}>
              Typing and the Clipboard
            </Text>
            <HelpCard items={typing} />

            <Text style={[styles.section, { color: theme.textFaint }]}>
              When a Pointer Is Easier
            </Text>
            <HelpCard
              items={[
                {
                  icon: "rectangle.and.hand.point.up.left",
                  title: "Trackpad Mode",
                  detail:
                    "Turn on from the ··· menu. Drag one finger to move the visible pointer, tap to click there, or double-tap and hold to drag.",
                },
              ]}
            />

            <Text style={[styles.section, { color: theme.textFaint }]}>Handing It Back</Text>
            <HelpCard
              items={[
                {
                  icon: "hand.raised",
                  title: "Return Control",
                  detail: "Use the ··· menu when you’re done so your Bot can continue.",
                },
              ]}
            />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    paddingTop: 112,
    paddingHorizontal: 9,
    backgroundColor: "rgba(0,0,0,0.58)",
  },
  safe: {
    flex: 1,
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    overflow: "hidden",
  },
  content: { paddingHorizontal: 9, paddingTop: 12, paddingBottom: 48 },
  header: {
    height: 55,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 18,
  },
  close: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  title: { paddingTop: 8, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  section: {
    marginLeft: 18,
    marginTop: 22,
    marginBottom: 10,
    fontSize: 13,
    lineHeight: 17,
  },
  card: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  item: {
    minHeight: 60,
    marginLeft: 18,
    paddingRight: 18,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  itemDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemCopy: { flex: 1, minWidth: 0 },
  itemTitle: { fontSize: 16, lineHeight: 21 },
  itemDetail: { marginTop: 2, fontSize: 13, lineHeight: 18 },
});
