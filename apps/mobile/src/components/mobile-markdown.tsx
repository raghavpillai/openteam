import { Fragment, type ReactNode, useMemo } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  boundedMobileMarkdownPreview,
  messageNeedsAdvancedMobileMarkdown,
  messageNeedsDomMobileMarkdown,
  parseInlineMarkdown,
  parseMobileMarkdown,
  shouldRenderRichMobileMarkdown,
} from "../mobile-markdown-core";
import { useTheme } from "../theme";
import AdvancedMarkdown from "./advanced-markdown.dom";

export { messageNeedsMobileMarkdown } from "../mobile-markdown-core";

function InlineMarkdown({
  text,
  color,
  linkColor,
  bold = false,
}: {
  text: string;
  color: string;
  linkColor: string;
  bold?: boolean;
}) {
  const tokens = parseInlineMarkdown(text);
  return (
    <Text selectable style={[styles.bodyText, bold && styles.strong, { color }]}>
      {tokens.map((token) => {
        if (token.type === "code") {
          return (
            <Text key={token.key} style={styles.inlineCode}>
              {token.text}
            </Text>
          );
        }
        if (token.type === "strong") {
          return (
            <Text key={token.key} style={styles.strong}>
              {token.text}
            </Text>
          );
        }
        if (token.type === "strike") {
          return (
            <Text key={token.key} style={styles.strike}>
              {token.text}
            </Text>
          );
        }
        if (token.type === "emphasis") {
          return (
            <Text key={token.key} style={styles.emphasis}>
              {token.text}
            </Text>
          );
        }
        if (token.type === "link") {
          return (
            <Text
              accessibilityRole="link"
              key={token.key}
              onPress={() => void Linking.openURL(token.url)}
              style={[styles.link, { color: linkColor }]}
            >
              {token.text}
            </Text>
          );
        }
        return <Fragment key={token.key}>{token.text}</Fragment>;
      })}
    </Text>
  );
}

export function MobileMarkdown({ content, color }: { content: string; color: string }) {
  const theme = useTheme();
  const rich = shouldRenderRichMobileMarkdown(content);
  const advanced = rich && messageNeedsAdvancedMobileMarkdown(content);
  const domAdvanced = advanced && messageNeedsDomMobileMarkdown(content);
  const plainPreview = useMemo(
    () => (rich ? null : boundedMobileMarkdownPreview(content)),
    [content, rich]
  );
  const blocks = useMemo(() => (rich ? parseMobileMarkdown(content) : []), [content, rich]);
  if (plainPreview) {
    return (
      <View style={styles.plainPreview}>
        <Text selectable style={[styles.bodyText, { color }]}>
          {plainPreview.text}
        </Text>
        {plainPreview.truncated ? (
          <Text
            accessibilityLabel="Large message preview truncated"
            style={[styles.previewNotice, { color: theme.textMuted }]}
          >
            Preview limited for performance. Long-press to copy the full message.
          </Text>
        ) : null}
      </View>
    );
  }
  if (domAdvanced) {
    return (
      <AdvancedMarkdown
        borderColor={theme.border}
        content={content}
        dark={theme.dark}
        dom={{
          contentInsetAdjustmentBehavior: "never",
          matchContents: true,
          scrollEnabled: false,
          showsHorizontalScrollIndicator: false,
          showsVerticalScrollIndicator: false,
        }}
        mutedColor={theme.textMuted}
        onOpenLink={async (url) => {
          await Linking.openURL(url);
        }}
        surfaceColor={theme.surfacePressed}
        textColor={color}
      />
    );
  }
  return (
    <View style={styles.root}>
      {blocks.map((block): ReactNode => {
        if (block.type === "code") {
          return (
            <View
              key={block.key}
              style={[styles.codeBlock, { backgroundColor: theme.surfacePressed }]}
            >
              {block.language ? (
                <Text style={[styles.codeLanguage, { color: theme.textMuted }]}>
                  {block.language === "mermaid" ? "diagram source" : block.language}
                </Text>
              ) : null}
              <ScrollView
                contentContainerStyle={styles.codeScrollContent}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.codeScroller}
              >
                <Text selectable style={[styles.codeText, { color: theme.text }]}>
                  {block.text}
                </Text>
              </ScrollView>
            </View>
          );
        }
        if (block.type === "rule") {
          return (
            <View key={block.key} style={[styles.rule, { backgroundColor: theme.separator }]} />
          );
        }
        if (block.type === "table") {
          const tableRows = [block.headers, ...block.rows];
          return (
            <View key={block.key} style={styles.table}>
              {tableRows.map((row, rowIndex) => (
                <View
                  key={rowIndex === 0 ? `${block.key}:header` : `${block.key}:row:${rowIndex}`}
                  style={[
                    styles.tableRow,
                    rowIndex > 0 && styles.tableRowBorder,
                    { borderColor: theme.separator },
                  ]}
                >
                  {row.map((cell, cellIndex) => (
                    <View
                      key={cell.key}
                      style={[
                        styles.tableCell,
                        cellIndex > 0 && styles.tableCellBorder,
                        { borderColor: theme.separator },
                      ]}
                    >
                      <InlineMarkdown
                        bold={rowIndex === 0}
                        color={rowIndex === 0 ? color : theme.textMuted}
                        linkColor={color}
                        text={cell.text}
                      />
                    </View>
                  ))}
                </View>
              ))}
            </View>
          );
        }
        if (block.type === "heading") {
          return (
            <Text
              key={block.key}
              selectable
              style={[
                styles.heading,
                block.level <= 2 ? styles.headingLarge : styles.headingSmall,
                { color },
              ]}
            >
              {block.text}
            </Text>
          );
        }
        if (block.type === "quote") {
          return (
            <View key={block.key} style={[styles.quote, { borderLeftColor: theme.textMuted }]}>
              <InlineMarkdown color={color} linkColor={color} text={block.text} />
            </View>
          );
        }
        if (block.type === "list") {
          return (
            <View key={block.key} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={item.key} style={styles.listRow}>
                  <Text style={[styles.marker, { color }]}>
                    {block.ordered ? `${itemIndex + 1}.` : "•"}
                  </Text>
                  <View style={styles.listText}>
                    <InlineMarkdown color={color} linkColor={color} text={item.text} />
                  </View>
                </View>
              ))}
            </View>
          );
        }
        return <InlineMarkdown color={color} key={block.key} linkColor={color} text={block.text} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  plainPreview: { gap: 8 },
  previewNotice: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
  bodyText: { fontSize: 16, lineHeight: 22, letterSpacing: -0.15 },
  strong: { fontWeight: "700" },
  emphasis: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  inlineCode: {
    fontFamily: "Menlo",
    fontSize: 13,
    backgroundColor: "rgba(127,127,127,0.16)",
  },
  link: { textDecorationLine: "underline" },
  heading: { fontWeight: "700" },
  headingLarge: { fontSize: 19, lineHeight: 24 },
  headingSmall: { fontSize: 16, lineHeight: 21 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, opacity: 0.88 },
  list: { gap: 4 },
  listRow: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
  marker: { width: 20, fontSize: 16, lineHeight: 22, textAlign: "right" },
  listText: { flex: 1 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 3 },
  table: { width: "100%" },
  tableRow: { flexDirection: "row" },
  tableRowBorder: { borderTopWidth: StyleSheet.hairlineWidth },
  tableCell: { flex: 1, minWidth: 0, paddingHorizontal: 7, paddingVertical: 7 },
  tableCellBorder: { borderLeftWidth: StyleSheet.hairlineWidth },
  codeBlock: { minWidth: 240, borderRadius: 10, padding: 11, gap: 6 },
  codeScroller: { flexGrow: 0 },
  codeScrollContent: { flexGrow: 0 },
  codeLanguage: { fontSize: 10, lineHeight: 13, fontWeight: "700", textTransform: "uppercase" },
  codeText: { fontFamily: "Menlo", fontSize: 12, lineHeight: 18 },
});
