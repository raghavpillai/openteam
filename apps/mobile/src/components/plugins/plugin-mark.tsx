import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Image, View, StyleSheet } from "react-native";
import { useTheme } from "../../theme";

export function PluginMark({ logoUrl, size = 36 }: { logoUrl?: string | null; size?: number }) {
  const theme = useTheme();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(logoUrl && logoUrl !== failedUrl);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(8, size * 0.24),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.border,
        backgroundColor: showImage ? "#FFFFFF" : theme.surfacePressed,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {showImage ? (
        <Image
          key={logoUrl}
          source={{ uri: logoUrl! }}
          resizeMode="contain"
          onError={() => setFailedUrl(logoUrl!)}
          style={{ width: size * 0.8, height: size * 0.8 }}
        />
      ) : (
        <SymbolView
          name="puzzlepiece.extension.fill"
          size={size * 0.54}
          tintColor={theme.textMuted}
        />
      )}
    </View>
  );
}
