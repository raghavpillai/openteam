import type { AssetRef, BotView, ChannelMessageView } from "@openteam/contracts";
import { a2aProjectionFor, messageMetadata } from "@openteam/product-core/messages";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Easing,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MOBILE_VIRTUAL_LIST_TUNING } from "../list-scale";
import { useTheme } from "../theme";
import { BotMark } from "./bot-mark";
import { GlassSurface } from "./glass-surface";
import { IconButton } from "./icon-button";
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
  exchange: MobileA2AExchange;
  onClose: () => void;
  onOpenComputer?: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const translateX = useRef(new Animated.Value(width)).current;
  const closing = useRef(false);
  const byId = useMemo(
    () => new Map(exchange.messages.map((message) => [message.id, message] as const)),
    [exchange.messages]
  );

  useEffect(() => {
    translateX.setValue(width);
    Animated.timing(translateX, {
      toValue: 0,
      duration: 190,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [translateX, width]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    Animated.timing(translateX, {
      toValue: width,
      duration: 170,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      closing.current = false;
      if (finished) onClose();
    });
  }, [onClose, translateX, width]);

  return (
    <Modal
      animationType="none"
      onRequestClose={close}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <Animated.View
        accessibilityLabel={`Read-only internal conversation for ${exchange.source.name}`}
        style={[styles.screen, { backgroundColor: theme.background, transform: [{ translateX }] }]}
      >
        <SafeAreaView style={styles.safe}>
          <FlatList
            {...MOBILE_VIRTUAL_LIST_TUNING}
            contentContainerStyle={styles.messages}
            data={exchange.messages}
            keyExtractor={(message) => message.id}
            renderItem={({ item }) => {
              const projection = a2aProjectionFor(item);
              const outgoing = projection?.direction === "outgoing";
              const metadata = messageMetadata(item);
              const replyId = metadata.replyTo;
              const replyPreview = typeof replyId === "string" ? byId.get(replyId)?.content : null;
              const speaker = outgoing ? exchange.source : exchange.peer;
              return (
                <View style={styles.exchangeMessage}>
                  <View style={styles.speakerRow}>
                    <BotMark color={speaker.color} icon={speaker.icon} size={14} />
                    <Text style={[styles.speakerName, { color: theme.textMuted }]}>
                      {speaker.name}
                    </Text>
                  </View>
                  <MessageBubble
                    alignRight={false}
                    animateEntrance={false}
                    assetUrl={assetUrl}
                    hideA2ALabel
                    message={item}
                    onReact={ignoreReadOnlyAction}
                    onReply={ignoreReadOnlyAction}
                    onComputerHandoff={rejectReadOnlyMutation}
                    onSecretSubmit={rejectReadOnlyMutation}
                    onWidgetDismiss={rejectReadOnlyMutation}
                    onWidgetResponse={rejectReadOnlyMutation}
                    pending={false}
                    peerBot={speaker}
                    readOnly
                    replyPreview={replyPreview}
                    speakerName={speaker.name}
                  />
                </View>
              );
            }}
          />

          <View style={[styles.header, { top: insets.top }]}>
            <IconButton
              haptic="light"
              label="Back to source conversation"
              name="chevron.left"
              onPress={close}
              size={38}
              symbolSize={18}
              tone="surface"
            />
          </View>

          <GlassSurface
            fallbackColor={theme.surfaceElevated}
            style={[styles.readOnly, { borderColor: theme.border }]}
          >
            <SymbolView name="lock.fill" size={12} tintColor={theme.textMuted} />
            <Text style={[styles.readOnlyLabel, { color: theme.textMuted }]}>Read-only</Text>
          </GlassSurface>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  safe: { flex: 1 },
  header: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 4,
    minHeight: 58,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
  },
  messages: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingTop: 74,
    paddingBottom: 82,
  },
  exchangeMessage: { width: "100%", marginBottom: 5 },
  speakerRow: {
    minHeight: 22,
    paddingHorizontal: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  speakerName: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  readOnly: {
    position: "absolute",
    bottom: 28,
    alignSelf: "center",
    minHeight: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  readOnlyLabel: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
});
