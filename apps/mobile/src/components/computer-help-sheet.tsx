import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

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
    detail: "Pinch to zoom. Zoomed in, two fingers pan instead of scrolling.",
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
  return (
    <View style={styles.card}>
      {items.map((item, index) => (
        <View
          key={item.title}
          style={[styles.item, index < items.length - 1 && styles.itemDivider]}
        >
          <SymbolView name={item.icon} size={20} tintColor="#969691" weight="regular" />
          <View style={styles.itemCopy}>
            <Text style={styles.itemTitle}>{item.title}</Text>
            <Text style={styles.itemDetail}>{item.detail}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function ComputerHelpSheet({ onClose, visible }: { onClose: () => void; visible: boolean }) {
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdrop}>
        <SafeAreaView edges={["bottom"]} style={styles.safe}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable
                accessibilityLabel="Close computer help"
                accessibilityRole="button"
                onPress={onClose}
                style={({ pressed }) => [styles.close, pressed && styles.pressed]}
              >
                <SymbolView name="xmark" size={20} tintColor="#F7F7F4" weight="medium" />
              </Pressable>
              <Text style={styles.title}>Using the Computer</Text>
            </View>

            <Text style={styles.section}>Moving Around</Text>
            <HelpCard items={moving} />

            <Text style={styles.section}>Typing and the Clipboard</Text>
            <HelpCard items={typing} />

            <Text style={styles.section}>When a Pointer Is Easier</Text>
            <HelpCard
              items={[
                {
                  icon: "rectangle.and.hand.point.up.left",
                  title: "Trackpad Mode",
                  detail:
                    "Turn on from the ··· menu. Your finger moves the pointer; tap to click there, double-tap and hold to drag. Recenter the pointer if it drifts.",
                },
              ]}
            />

            <Text style={styles.section}>Handing It Back</Text>
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
    backgroundColor: "#111111",
    overflow: "hidden",
  },
  content: { paddingHorizontal: 9, paddingTop: 12, paddingBottom: 48 },
  header: { height: 70, flexDirection: "row", alignItems: "flex-start", gap: 18 },
  close: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "#2B2B2B",
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  title: { paddingTop: 10, color: "#F7F7F4", fontSize: 17, lineHeight: 22, fontWeight: "600" },
  section: {
    marginLeft: 18,
    marginTop: 22,
    marginBottom: 10,
    color: "#61615E",
    fontSize: 13,
    lineHeight: 17,
  },
  card: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
    backgroundColor: "#202020",
    overflow: "hidden",
  },
  item: {
    minHeight: 78,
    marginLeft: 18,
    paddingRight: 18,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  itemDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  itemCopy: { flex: 1, minWidth: 0 },
  itemTitle: { color: "#F7F7F4", fontSize: 16, lineHeight: 21 },
  itemDetail: { marginTop: 2, color: "#969691", fontSize: 13, lineHeight: 18 },
});
