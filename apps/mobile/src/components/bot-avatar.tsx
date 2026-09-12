import type { BotView } from "@openteam/contracts";
import { DEFAULT_BOT_AVATAR } from "@openteam/contracts/bot-avatar";
import { memo, useMemo, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { getAuthTokenForServer } from "../auth";
import { botAvatarSource } from "../bot-avatar-source";
import { useOpenTeam } from "../state/openteam-context";
import { BotMark } from "./bot-mark";

export const BotAvatar = memo(function BotAvatar({
  bot,
  color = bot?.color ?? DEFAULT_BOT_AVATAR.color,
  icon = bot?.icon,
  size = 48,
  showCustomAvatar = true,
}: {
  bot?: Pick<BotView, "id" | "hasAvatar" | "updatedAt" | "color" | "icon">;
  color?: string;
  icon?: string;
  size?: number;
  showCustomAvatar?: boolean;
}) {
  const { connection, isFixture } = useOpenTeam();
  const serverUrl = isFixture ? "" : connection.serverUrl;
  const token = getAuthTokenForServer(serverUrl);
  const source = useMemo(
    () => botAvatarSource(serverUrl, showCustomAvatar ? bot : undefined, token),
    [serverUrl, bot?.id, bot?.hasAvatar, bot?.updatedAt, showCustomAvatar, token]
  );
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  const imageSource = source?.uri === failedUri ? null : source;

  return (
    <View style={{ width: size, height: size }}>
      {(!imageSource || loadedUri !== imageSource.uri) && (
        <BotMark color={color} icon={icon} size={size} />
      )}
      {imageSource && (
        <Image
          accessibilityLabel="Bot avatar"
          key={imageSource.uri}
          onError={() => setFailedUri(imageSource.uri)}
          onLoad={() => setLoadedUri(imageSource.uri)}
          resizeMode="cover"
          source={imageSource}
          style={StyleSheet.absoluteFill}
        />
      )}
    </View>
  );
});
