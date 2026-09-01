import type { AssetRef, BotView, ChannelMessageView } from "@openbot/contracts";
import { a2aProjectionFor, messageMetadata } from "@openbot/product-core/messages";
import { SymbolView } from "expo-symbols";
import { useMemo } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MOBILE_VIRTUAL_LIST_TUNING } from "../list-scale";
import { useTheme } from "../theme";
import { BotMark } from "./bot-mark";
import { MessageBubble } from "./message-bubble";

const ignoreReadOnlyAction = () => undefined;
const rejectReadOnlyMutation = async () => false;

export interface MobileA2AExchange {
  source: BotView;
  peer: BotView;
  messages: ChannelMessageView[];
}

export function A2AExchangeSheet({
  assetUrl,
  exchange,
  onClose,
}: {
  assetUrl: (asset: Pick<AssetRef, "assetId" | "fileName">, download?: boolean) => string | null;
  exchange: MobileA2AExchange | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const byId = useMemo(
    () => new Map((exchange?.messages ?? []).map((message) => [message.id, message] as const)),
    [exchange?.messages]
  );

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={Boolean(exchange)}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.separator }]}>
          <Pressable
            accessible
            accessibilityLabel="Close A2A exchange"
            accessibilityRole="button"
            onPress={onClose}
            style={styles.headerAction}
          >
            <Text style={[styles.headerActionText, { color: theme.accent }]}>Close</Text>
          </Pressable>
          <View style={styles.headerIdentity}>
            <View style={styles.botPair}>
              <BotMark
                color={exchange?.source.color ?? "#858580"}
                icon={exchange?.source.icon}
                size={25}
              />
              <BotMark
                color={exchange?.peer.color ?? "#858580"}
                icon={exchange?.peer.icon}
                size={25}
              />
            </View>
            <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
              {exchange ? `${exchange.source.name} ↔ ${exchange.peer.name}` : "Agent exchange"}
            </Text>
            <View style={styles.viewOnlyRow}>
              <SymbolView name="lock.fill" size={10} tintColor={theme.textMuted} />
              <Text style={[styles.subtitle, { color: theme.textMuted }]}>View-only exchange</Text>
            </View>
          </View>
          <View style={styles.headerAction} />
        </View>

        <FlatList
          {...MOBILE_VIRTUAL_LIST_TUNING}
          data={exchange?.messages ?? []}
          keyExtractor={(message) => message.id}
          contentContainerStyle={styles.messages}
          renderItem={({ item }) => {
            const projection = a2aProjectionFor(item);
            const outgoing = projection?.direction === "outgoing";
            const metadata = messageMetadata(item);
            const replyId = metadata.replyTo;
            const replyPreview = typeof replyId === "string" ? byId.get(replyId)?.content : null;
            const speaker = outgoing ? exchange?.source : exchange?.peer;
            return (
              <MessageBubble
                alignRight={outgoing}
                animateEntrance={false}
                assetUrl={assetUrl}
                hideA2ALabel
                message={item}
                onReact={ignoreReadOnlyAction}
                onReply={ignoreReadOnlyAction}
                onSecretSubmit={rejectReadOnlyMutation}
                onWidgetDismiss={rejectReadOnlyMutation}
                onWidgetResponse={rejectReadOnlyMutation}
                pending={false}
                peerBot={speaker}
                readOnly
                replyPreview={replyPreview}
                speakerName={speaker?.name}
              />
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    minHeight: 76,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
  },
  headerAction: { width: 56, minHeight: 44, justifyContent: "center" },
  headerActionText: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  headerIdentity: { flex: 1, minWidth: 0, alignItems: "center", gap: 2 },
  botPair: { flexDirection: "row", marginBottom: 1 },
  title: { maxWidth: "100%", fontSize: 15, lineHeight: 19, fontWeight: "700" },
  viewOnlyRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  subtitle: { fontSize: 11, lineHeight: 14, fontWeight: "500" },
  messages: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 16,
  },
});
