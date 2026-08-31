import type {
  BotView,
  SearchCategory,
  SearchResultKind,
  SearchResultView,
} from "@openbot/contracts";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotMark } from "../src/components/bot-mark";
import { GlassSurface } from "../src/components/glass-surface";
import { IconButton } from "../src/components/icon-button";
import { useOpenBot } from "../src/state/openbot-context";
import { type Theme, useTheme } from "../src/theme";

type SearchSection = {
  category: SearchCategory;
  label: string;
  icon: SymbolViewProps["name"];
  emptyTitle: string;
  emptyCopy: string;
};

type PageState = {
  query: string;
  results: SearchResultView[];
  loading: boolean;
  error: string | null;
};

const SEARCH_DEBOUNCE_MS = 100;

const SEARCH_SECTIONS: readonly SearchSection[] = [
  {
    category: "all",
    label: "All",
    icon: "square.grid.2x2",
    emptyTitle: "Nothing found",
    emptyCopy: "Try another name, phrase, file, or link.",
  },
  {
    category: "messages",
    label: "Messages",
    icon: "bubble.left",
    emptyTitle: "Search messages",
    emptyCopy: "Type a phrase to search across your conversations.",
  },
  {
    category: "bots",
    label: "Bots",
    icon: "person.crop.circle",
    emptyTitle: "No bots found",
    emptyCopy: "Try a Bot name or description.",
  },
  {
    category: "channels",
    label: "Chats",
    icon: "number",
    emptyTitle: "No chats found",
    emptyCopy: "Try a conversation or group name.",
  },
  {
    category: "files",
    label: "Files",
    icon: "doc",
    emptyTitle: "No files found",
    emptyCopy: "Files shared in visible conversations appear here.",
  },
  {
    category: "links",
    label: "Links",
    icon: "link",
    emptyTitle: "No links found",
    emptyCopy: "Links shared in visible conversations appear here.",
  },
  {
    category: "routines",
    label: "Routines",
    icon: "clock",
    emptyTitle: "No routines found",
    emptyCopy: "Try a routine name or description.",
  },
] as const;

const normalizedQuery = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();

const resultKindLabel = (kind: SearchResultKind) => {
  switch (kind) {
    case "bot":
      return "Bot";
    case "channel":
      return "Chat";
    case "message":
      return "Message";
    case "file":
      return "File";
    case "link":
      return "Link";
    case "routine":
      return "Routine";
  }
};

const resultSymbol = (kind: SearchResultKind): SymbolViewProps["name"] => {
  switch (kind) {
    case "message":
      return "bubble.left";
    case "channel":
      return "number";
    case "file":
      return "doc";
    case "link":
      return "link";
    case "routine":
      return "clock";
    default:
      return "person.crop.circle";
  }
};

function ResultGlyph({
  result,
  botById,
}: {
  result: SearchResultView;
  botById: Map<string, BotView>;
}) {
  const theme = useTheme();
  const bot = result.botId ? botById.get(result.botId) : undefined;
  if (bot && (result.kind === "bot" || result.kind === "message")) {
    return <BotMark color={bot.color} icon={bot.icon} size={42} />;
  }
  return (
    <View style={[styles.resultGlyph, { backgroundColor: theme.surface }]}>
      <SymbolView name={resultSymbol(result.kind)} size={17} tintColor={theme.textMuted} />
    </View>
  );
}

function SearchResultRow({
  botById,
  onPress,
  result,
}: {
  botById: Map<string, BotView>;
  onPress: () => void;
  result: SearchResultView;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={`${resultKindLabel(result.kind)}: ${result.title}. ${result.subtitle}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.resultRow,
        pressed && { backgroundColor: theme.surface, transform: [{ scale: 0.992 }] },
      ]}
    >
      <ResultGlyph botById={botById} result={result} />
      <View style={styles.resultCopy}>
        <View style={styles.resultTitleLine}>
          <Text numberOfLines={1} style={[styles.resultTitle, { color: theme.text }]}>
            {result.title}
          </Text>
          <Text style={[styles.resultKind, { color: theme.textFaint }]}>
            {resultKindLabel(result.kind)}
          </Text>
        </View>
        <Text numberOfLines={2} style={[styles.resultSubtitle, { color: theme.textMuted }]}>
          {result.subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

function SearchPage({
  botById,
  onOpenResult,
  onRetry,
  query,
  section,
  state,
  theme,
  width,
}: {
  botById: Map<string, BotView>;
  onOpenResult: (result: SearchResultView) => void;
  onRetry: () => void;
  query: string;
  section: SearchSection;
  state?: PageState;
  theme: Theme;
  width: number;
}) {
  const current = state?.query === query ? state : undefined;
  const results = current?.results ?? [];
  const waiting = !current || (current.loading && results.length === 0);
  const hasQuery = query.length > 0;
  const emptyTitle =
    hasQuery || section.category !== "all" ? section.emptyTitle : "Nothing here yet";

  return (
    <View style={[styles.page, { width }]}>
      {waiting ? (
        <View style={styles.centerState}>
          <ActivityIndicator color={theme.textMuted} />
          <Text style={[styles.stateCopy, { color: theme.textMuted }]}>Searching…</Text>
        </View>
      ) : current.error && results.length === 0 ? (
        <View style={styles.centerState}>
          <View style={[styles.emptyIcon, { backgroundColor: theme.surface }]}>
            <SymbolView
              name="exclamationmark.arrow.circlepath"
              size={22}
              tintColor={theme.textMuted}
            />
          </View>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>Search unavailable</Text>
          <Text style={[styles.emptyCopy, { color: theme.textMuted }]}>{current.error}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={onRetry}
            style={({ pressed }) => [
              styles.retry,
              { backgroundColor: theme.text },
              pressed && { opacity: 0.72 },
            ]}
          >
            <Text style={[styles.retryText, { color: theme.background }]}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={[styles.results, results.length === 0 && styles.emptyResults]}
          data={results}
          keyExtractor={(result) => result.id}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <SearchResultRow botById={botById} onPress={() => onOpenResult(item)} result={item} />
          )}
          ListEmptyComponent={
            <View style={styles.centerState}>
              <View style={[styles.emptyIcon, { backgroundColor: theme.surface }]}>
                <SymbolView name={section.icon} size={21} tintColor={theme.textMuted} />
              </View>
              <Text style={[styles.emptyTitle, { color: theme.text }]}>{emptyTitle}</Text>
              <Text style={[styles.emptyCopy, { color: theme.textMuted }]}>
                {section.emptyCopy}
              </Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

export default function SearchScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const { search, snapshot } = useOpenBot();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [pageStates, setPageStates] = useState<Partial<Record<SearchCategory, PageState>>>({});
  const [retryRevision, setRetryRevision] = useState(0);
  const pagesRef = useRef<FlatList<SearchSection>>(null);
  const tabsRef = useRef<FlatList<SearchSection>>(null);
  const cacheRef = useRef(new Map<string, SearchResultView[]>());
  const normalized = normalizedQuery(query);
  const activeSection = SEARCH_SECTIONS[activeIndex] ?? SEARCH_SECTIONS[0];
  const botById = useMemo(
    () => new Map(snapshot.bots.map((bot) => [bot.id, bot])),
    [snapshot.bots]
  );

  useEffect(() => {
    cacheRef.current.clear();
    setPageStates({});
  }, [snapshot.cursor]);

  useEffect(() => {
    const category = activeSection.category;
    const cacheKey = `${category}:${normalized.toLocaleLowerCase()}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setPageStates((current) => ({
        ...current,
        [category]: { query: normalized, results: cached, loading: false, error: null },
      }));
      return;
    }

    const controller = new AbortController();
    setPageStates((current) => ({
      ...current,
      [category]: { query: normalized, results: [], loading: true, error: null },
    }));
    const timer = setTimeout(
      () => {
        void search(normalized, category, controller.signal)
          .then((response) => {
            if (controller.signal.aborted) return;
            cacheRef.current.set(cacheKey, response.results);
            setPageStates((current) => ({
              ...current,
              [category]: {
                query: normalized,
                results: response.results,
                loading: false,
                error: null,
              },
            }));
          })
          .catch((cause) => {
            if (controller.signal.aborted) return;
            setPageStates((current) => ({
              ...current,
              [category]: {
                query: normalized,
                results: [],
                loading: false,
                error: cause instanceof Error ? cause.message : "Search failed",
              },
            }));
          });
      },
      normalized ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeSection.category, normalized, retryRevision, search]);

  useEffect(() => {
    pagesRef.current?.scrollToOffset({ animated: false, offset: activeIndex * width });
  }, [width]);

  const showSection = useCallback(
    (index: number, animated = true) => {
      const nextIndex = Math.max(0, Math.min(SEARCH_SECTIONS.length - 1, index));
      setActiveIndex(nextIndex);
      pagesRef.current?.scrollToOffset({ animated, offset: nextIndex * width });
      tabsRef.current?.scrollToIndex({ animated: true, index: nextIndex, viewPosition: 0.5 });
    },
    [width]
  );

  const pageSwipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_, gesture) =>
          Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.25,
        onPanResponderRelease: (_, gesture) => {
          if (Math.abs(gesture.dx) < 42 && Math.abs(gesture.vx) < 0.35) return;
          const direction = gesture.dx < 0 ? 1 : -1;
          const nextIndex = Math.max(
            0,
            Math.min(SEARCH_SECTIONS.length - 1, activeIndex + direction)
          );
          if (nextIndex === activeIndex) return;
          void Haptics.selectionAsync();
          showSection(nextIndex);
        },
      }),
    [activeIndex, showSection]
  );

  const openResult = useCallback(
    (result: SearchResultView) => {
      void Haptics.selectionAsync();
      if (result.kind === "link" && result.url) {
        void Linking.openURL(result.url);
        return;
      }
      const channelId =
        result.channelId ??
        (result.botId ? snapshot.bots.find((bot) => bot.id === result.botId)?.dmChannelId : null);
      if (!channelId) return;
      router.replace({
        pathname: "/chat/[channelId]",
        params: {
          channelId,
          ...(result.messageId ? { messageId: result.messageId } : {}),
        },
      });
    },
    [snapshot.bots]
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <IconButton
          label="Close search"
          name="chevron.left"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          symbolSize={18}
          tone="surface"
        />
        <GlassSurface
          fallbackColor={theme.surface}
          interactive
          style={[styles.searchField, { borderColor: theme.border }]}
        >
          <SymbolView name="magnifyingglass" size={17} tintColor={theme.textMuted} />
          <TextInput
            accessibilityLabel="Search OpenBot"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            clearButtonMode="while-editing"
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.textFaint}
            selectionColor={theme.accent}
            style={[styles.input, { color: theme.text }]}
            value={query}
          />
        </GlassSurface>
      </View>

      <FlatList
        contentContainerStyle={styles.tabs}
        data={SEARCH_SECTIONS}
        horizontal
        keyExtractor={(section) => section.category}
        onScrollToIndexFailed={({ averageItemLength, index }) =>
          tabsRef.current?.scrollToOffset({
            animated: true,
            offset: Math.max(0, averageItemLength * index - width / 2),
          })
        }
        ref={tabsRef}
        renderItem={({ item, index }) => {
          const active = index === activeIndex;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => {
                void Haptics.selectionAsync();
                showSection(index);
              }}
              style={({ pressed }) => [
                styles.tab,
                {
                  backgroundColor: active ? theme.text : theme.surface,
                  borderColor: active ? theme.text : theme.border,
                },
                pressed && { opacity: 0.72 },
              ]}
            >
              <SymbolView
                name={item.icon}
                size={13}
                tintColor={active ? theme.background : theme.textMuted}
              />
              <Text
                style={[styles.tabLabel, { color: active ? theme.background : theme.textMuted }]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        }}
        showsHorizontalScrollIndicator={false}
        style={styles.tabRail}
      />

      <View style={[styles.divider, { backgroundColor: theme.separator }]} />

      <View style={styles.pages} {...pageSwipe.panHandlers}>
        <FlatList
          data={SEARCH_SECTIONS}
          getItemLayout={(_, index) => ({ index, length: width, offset: width * index })}
          horizontal
          initialNumToRender={2}
          keyExtractor={(section) => `page-${section.category}`}
          keyboardShouldPersistTaps="handled"
          ref={pagesRef}
          renderItem={({ item }) => (
            <SearchPage
              botById={botById}
              onOpenResult={openResult}
              onRetry={() => setRetryRevision((current) => current + 1)}
              query={normalized}
              section={item}
              state={pageStates[item.category]}
              theme={theme}
              width={width}
            />
          )}
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          style={styles.pages}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    minHeight: 58,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  searchField: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    overflow: "hidden",
  },
  input: { flex: 1, height: 40, paddingVertical: 0, fontSize: 16, lineHeight: 21 },
  tabs: { gap: 7, paddingHorizontal: 16, paddingBottom: 10, paddingTop: 4 },
  tabRail: { flexGrow: 0, height: 48 },
  tab: {
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  tabLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  divider: { height: StyleSheet.hairlineWidth },
  pages: { flex: 1 },
  page: { flex: 1 },
  results: { paddingHorizontal: 16, paddingBottom: 34, paddingTop: 8 },
  emptyResults: { flexGrow: 1 },
  resultRow: {
    minHeight: 70,
    borderRadius: 18,
    paddingHorizontal: 7,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  resultGlyph: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  resultCopy: { flex: 1, gap: 3 },
  resultTitleLine: { flexDirection: "row", alignItems: "center", gap: 10 },
  resultTitle: { flex: 1, fontSize: 15, lineHeight: 19, fontWeight: "600" },
  resultKind: { fontSize: 10, lineHeight: 14, fontWeight: "600" },
  resultSubtitle: { fontSize: 13, lineHeight: 18 },
  centerState: {
    flex: 1,
    minHeight: 250,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 34,
  },
  stateCopy: { marginTop: 10, fontSize: 13, lineHeight: 18 },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { marginTop: 13, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  emptyCopy: { marginTop: 4, maxWidth: 280, textAlign: "center", fontSize: 13, lineHeight: 18 },
  retry: {
    marginTop: 16,
    height: 38,
    borderRadius: 19,
    paddingHorizontal: 17,
    justifyContent: "center",
  },
  retryText: { fontSize: 13, lineHeight: 17, fontWeight: "700" },
});
