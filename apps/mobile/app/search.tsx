import type {
  BotView,
  SearchCategory,
  SearchResultKind,
  SearchResultView,
} from "@openteam/contracts";
import {
  createSearchRequestGate,
  readSearchCache,
  SEARCH_CATEGORIES,
  SEARCH_QUERY_MAX_LENGTH,
  searchCacheKey,
  searchResultKindLabel,
  writeSearchCache,
} from "@openteam/product-core/search";
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
import { stageRoutineNavigation } from "../src/routine-route";
import { normalizeMobileSearchQuery } from "../src/search";
import { searchFailureMessage } from "../src/search-error";
import { useOpenTeam } from "../src/state/openteam-context";
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

const SEARCH_SECTION_DETAILS: Record<
  SearchCategory,
  Pick<SearchSection, "icon" | "emptyTitle" | "emptyCopy">
> = {
  all: {
    icon: "square.grid.2x2",
    emptyTitle: "Nothing found",
    emptyCopy: "Try another name, phrase, file, or link.",
  },
  messages: {
    icon: "bubble.left",
    emptyTitle: "Search messages",
    emptyCopy: "Type a phrase to search across your conversations.",
  },
  bots: {
    icon: "person.crop.circle",
    emptyTitle: "No bots found",
    emptyCopy: "Try a Bot name or description.",
  },
  channels: {
    icon: "number",
    emptyTitle: "No chats found",
    emptyCopy: "Try a conversation or group name.",
  },
  files: {
    icon: "doc",
    emptyTitle: "No files found",
    emptyCopy: "Files shared in visible conversations appear here.",
  },
  links: {
    icon: "link",
    emptyTitle: "No links found",
    emptyCopy: "Links shared in visible conversations appear here.",
  },
  routines: {
    icon: "clock",
    emptyTitle: "No routines found",
    emptyCopy: "Try a routine name or description.",
  },
};

const SEARCH_SECTIONS: readonly SearchSection[] = SEARCH_CATEGORIES.filter(
  ({ category }) => category !== "links"
).map(({ category, label }) => ({
  category,
  label: category === "channels" ? "Groups" : label,
  ...SEARCH_SECTION_DETAILS[category],
}));

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
    return <BotMark color={bot.color} icon={bot.icon} size={48} />;
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
      accessibilityLabel={`${searchResultKindLabel(result.kind)}: ${result.title}. ${result.subtitle}`}
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
            {result.kind === "channel" ? "Group" : searchResultKindLabel(result.kind)}
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
  active,
  botById,
  onOpenResult,
  onRetry,
  query,
  section,
  state,
  theme,
  width,
}: {
  active: boolean;
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
    <View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      style={[styles.page, { width }]}
    >
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
  const { search, snapshot } = useOpenTeam();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [pageStates, setPageStates] = useState<Partial<Record<SearchCategory, PageState>>>({});
  const [retryRevision, setRetryRevision] = useState(0);
  const pagesRef = useRef<FlatList<SearchSection>>(null);
  const tabsRef = useRef<FlatList<SearchSection>>(null);
  const cacheRef = useRef(new Map<string, SearchResultView[]>());
  const cacheCursorRef = useRef(snapshot.cursor);
  const [requestGate] = useState(createSearchRequestGate);
  const normalized = normalizeMobileSearchQuery(query);
  const activeSection = SEARCH_SECTIONS[activeIndex] ?? SEARCH_SECTIONS[0];
  const botById = useMemo(
    () => new Map(snapshot.bots.map((bot) => [bot.id, bot])),
    [snapshot.bots]
  );

  useEffect(() => {
    if (cacheCursorRef.current === snapshot.cursor) return;
    cacheCursorRef.current = snapshot.cursor;
    requestGate.invalidate();
    cacheRef.current.clear();
    setPageStates({});
  }, [requestGate, snapshot.cursor]);

  useEffect(() => {
    void retryRevision;
    const category = activeSection.category;
    const cacheKey = searchCacheKey(snapshot.cursor, category, normalized);
    const cached = readSearchCache(cacheRef.current, cacheKey);
    if (cached) {
      setPageStates((current) => ({
        ...current,
        [category]: { query: normalized, results: cached, loading: false, error: null },
      }));
      return;
    }

    const controller = new AbortController();
    const requestToken = requestGate.begin(cacheKey);
    setPageStates((current) => ({
      ...current,
      [category]: { query: normalized, results: [], loading: true, error: null },
    }));
    const timer = setTimeout(
      () => {
        void search(normalized, category, controller.signal)
          .then((response) => {
            if (controller.signal.aborted || !requestGate.isCurrent(requestToken)) return;
            const results =
              category === "all" && !normalized
                ? response.results.filter(
                    (result) =>
                      result.kind === "bot" || (result.kind === "channel" && result.botId === null)
                  )
                : response.results;
            writeSearchCache(cacheRef.current, cacheKey, results);
            setPageStates((current) => ({
              ...current,
              [category]: {
                query: normalized,
                results,
                loading: false,
                error: null,
              },
            }));
          })
          .catch((cause) => {
            if (controller.signal.aborted || !requestGate.isCurrent(requestToken)) return;
            setPageStates((current) => ({
              ...current,
              [category]: {
                query: normalized,
                results: [],
                loading: false,
                error: searchFailureMessage(cause),
              },
            }));
          });
      },
      normalized ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (requestGate.isCurrent(requestToken)) requestGate.invalidate();
    };
  }, [activeSection.category, normalized, requestGate, retryRevision, search, snapshot.cursor]);

  useEffect(() => {
    pagesRef.current?.scrollToOffset({ animated: false, offset: activeIndex * width });
  }, [activeIndex, width]);

  const showSection = useCallback(
    (index: number, animated = true) => {
      const nextIndex = Math.max(0, Math.min(SEARCH_SECTIONS.length - 1, index));
      setActiveIndex(nextIndex);
      setFilterOpen(false);
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
      if (result.kind === "routine") {
        const routineId = result.id.startsWith("routine:")
          ? result.id.slice("routine:".length)
          : result.id;
        stageRoutineNavigation(channelId, routineId);
        // The staged identifier survives Search's native modal replacement. The
        // Details screen consumes it after its stack transition has settled.
        router.replace({
          pathname: "/details/[channelId]",
          params: { channelId },
        });
        return;
      }
      router.dismissTo({
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
          name="xmark"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          symbolSize={18}
          size={40}
          tone="surface"
        />
        <GlassSurface
          fallbackColor={theme.surface}
          interactive
          style={[styles.searchField, { borderColor: theme.border }]}
        >
          <SymbolView name="magnifyingglass" size={17} tintColor={theme.textMuted} />
          <TextInput
            accessibilityLabel="Search OpenTeam"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            clearButtonMode="while-editing"
            keyboardAppearance={theme.dark ? "dark" : "light"}
            maxLength={SEARCH_QUERY_MAX_LENGTH}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.textFaint}
            selectionColor={theme.accent}
            style={[styles.input, { color: theme.text }]}
          />
        </GlassSurface>
        <IconButton
          label={`Search category: ${activeSection.label}`}
          name="line.3.horizontal.decrease"
          onPress={() => {
            void Haptics.selectionAsync();
            setFilterOpen((current) => !current);
          }}
          size={40}
          symbolSize={18}
          tone="surface"
        />
      </View>

      <View style={styles.pages} {...pageSwipe.panHandlers}>
        <FlatList
          data={SEARCH_SECTIONS}
          getItemLayout={(_, index) => ({ index, length: width, offset: width * index })}
          horizontal
          initialNumToRender={2}
          keyExtractor={(section) => `page-${section.category}`}
          keyboardShouldPersistTaps="handled"
          ref={pagesRef}
          renderItem={({ index, item }) => (
            <SearchPage
              active={index === activeIndex}
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

      {filterOpen ? (
        <>
          <Pressable
            accessibilityLabel="Close search categories"
            onPress={() => setFilterOpen(false)}
            style={styles.filterBackdrop}
          />
          <GlassSurface
            fallbackColor={theme.dark ? "rgba(49,49,49,0.98)" : "rgba(245,245,245,0.98)"}
            style={[styles.filterMenu, { borderColor: theme.border, shadowColor: "#000" }]}
          >
            {SEARCH_SECTIONS.map((section, index) => {
              const active = index === activeIndex;
              return (
                <Pressable
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: active }}
                  key={section.category}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    showSection(index);
                  }}
                  style={({ pressed }) => [
                    styles.filterRow,
                    pressed && {
                      backgroundColor: theme.dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)",
                    },
                  ]}
                >
                  <View style={styles.filterCheck}>
                    {active ? (
                      <SymbolView
                        name="checkmark"
                        size={14}
                        tintColor={theme.text}
                        weight="semibold"
                      />
                    ) : null}
                  </View>
                  <Text style={[styles.filterLabel, { color: theme.text }]}>{section.label}</Text>
                </Pressable>
              );
            })}
          </GlassSurface>
        </>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    minHeight: 58,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
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
  results: { paddingHorizontal: 16, paddingBottom: 34, paddingTop: 26 },
  emptyResults: { flexGrow: 1 },
  resultRow: {
    minHeight: 70,
    borderRadius: 18,
    paddingHorizontal: 2,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  resultGlyph: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  resultCopy: { flex: 1, gap: 3 },
  resultTitleLine: { flexDirection: "row", alignItems: "center", gap: 10 },
  resultTitle: { flex: 1, fontSize: 16, lineHeight: 20, fontWeight: "600" },
  resultKind: { fontSize: 10, lineHeight: 14, fontWeight: "600" },
  resultSubtitle: { fontSize: 14, lineHeight: 18 },
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
  filterBackdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    zIndex: 20,
  },
  filterMenu: {
    position: "absolute",
    right: 8,
    top: 0,
    width: 228,
    zIndex: 21,
    borderRadius: 25,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    paddingVertical: 4,
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  filterRow: {
    height: 40,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  filterCheck: { width: 18, alignItems: "center" },
  filterLabel: { fontSize: 16, lineHeight: 21, fontWeight: "400" },
});
