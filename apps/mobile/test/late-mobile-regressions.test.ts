import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("late native iOS regression guards", () => {
  test("threads reset reply state, report reads, focus deep links, and follow the live edge", async () => {
    const [route, sheet, bubble] = await Promise.all([
      source("app/chat/[channelId].tsx"),
      source("src/components/thread-sheet.tsx"),
      source("src/components/message-bubble.tsx"),
    ]);

    expect(sheet).toContain("}, [threadRootId]);");
    expect(sheet).toContain("setReplyTarget(null)");
    expect(sheet).toContain("onViewableItemsChanged={onViewableItemsChanged}");
    expect(sheet).toContain("onVisibleSequenceRef.current(highest)");
    expect(sheet).toContain("targetMessageId");
    expect(sheet).toContain("scrollToEnd({ animated: true })");
    expect(sheet).toContain("maintainVisibleContentPosition={{ minIndexForVisible: 0 }}");
    expect(sheet).toContain("Load earlier thread replies");
    expect(sheet).toContain("replyTarget?.id ?? thread.root.id");
    expect(route).toContain("onVisibleSequence={recordVisibleSequence}");
    expect(route).toContain(
      "targetMessageId={focusedThreadRootId === threadRootId ? messageId : undefined}"
    );
    expect(route).toContain("threadRootByReplyId.has(message.id)");
    expect(route).toContain("mayHaveEarlierThreadReplies(");
    expect(route).toContain("historyHasMore={activeThreadHasMore}");
    expect(route).toContain("threadReplyCountIsPartial={threadReplyCountIsPartial}");
    expect(route).toContain("root ? { root, replies: [] } : null");
    expect(route).toContain("onStartThread={() => setThreadRootId(item.id)}");
    expect(route).toContain("addSidebarUnread(sidebarPreferences, [channelId])");
    expect(route).toContain('"Could not mark as unread"');
    expect(sheet).toContain('presentationStyle="fullScreen"');
    expect(sheet).toContain('name="chevron.left"');
    expect(sheet).toContain("placeholder={`Reply $" + "{botName}`}");
    expect(sheet).not.toContain("replyPreview=");
    expect(bubble).toContain("threadReplyCountLabel(threadReplyCount, threadReplyCountIsPartial)");
    expect(bubble).toContain("routineChangedEventFor(message)");
    expect(bubble).toContain("onOpenRoutine?.(routineEvent.automationId)");
    expect(route).toContain("router.push(routineRoute(channelId, routineId))");
    expect(route).toContain("onOpenRoutine={openRoutine}");
  });

  test("search leaves native text entry uncontrolled while state drives debounced results", async () => {
    const [route, details] = await Promise.all([
      source("app/search.tsx"),
      source("app/details/[channelId].tsx"),
    ]);

    expect(route).toContain("onChangeText={setQuery}");
    expect(route).toContain("query={normalized}");
    expect(route).not.toContain("value={query}");
    expect(route).toContain("accessibilityElementsHidden={!active}");
    expect(route).toContain('importantForAccessibility={active ? "auto" : "no-hide-descendants"}');
    expect(route).toContain("active={index === activeIndex}");
    expect(route).toContain('if (result.kind === "routine")');
    expect(route).toContain("router.replace({");
    expect(route).toContain('pathname: "/details/[channelId]"');
    expect(route).toContain('result.id.slice("routine:".length)');
    expect(route).toContain("stageRoutineNavigation(channelId, routineId)");
    expect(details).toContain("routineIdFromPathname(pathname)");
    expect(details).toContain("pendingRoutineId(channelId)");
    expect(details).toContain("ROUTINE_EDITOR_NAVIGATION_DELAY_MS");
    expect(details).toContain("return () => clearTimeout(timer)");
    expect(details).toContain("requestedRoutineId && availableRoutineIds.has(requestedRoutineId)");
    expect(details).toContain("handledRoutineDeepLink.current === targetRoutineId");
    expect(details).toContain('pathname: "/routine/[channelId]/[routineId]"');
    expect(details).toContain("params: { channelId, routineId: targetRoutineId }");
  });

  test("reaction failures are handled instead of becoming unhandled rejections", async () => {
    const route = await source("app/chat/[channelId].tsx");

    expect(route).toContain("await reactToMessage(messageId, emoji)");
    expect(route).toContain('Alert.alert(\n          "Reaction not sent"');
    expect(route).toContain("onReact={handleReaction}");
  });

  test("details preserve dirty edits across unrelated snapshot updates", async () => {
    const details = await source("app/details/[channelId].tsx");

    expect(details).toContain("formDirtyRef.current");
    expect(details).toContain("authoritativeMemberIdsKey");
    expect(details).not.toContain("bot?.updatedAt, channel?.id, channel?.updatedAt");
  });

  test("routine edits preserve composite triggers and refresh transient execution state", async () => {
    const editor = await source("src/components/routine-editor-sheet.tsx");

    expect(editor).toContain("compositeSchedule");
    expect(editor).toContain("routineScheduleEditMode(routine)");
    expect(editor).toContain("routineSchedulePatch(routine, schedule)");
    expect(editor).not.toContain("scheduleChanged ? { schedule: normalizedSchedule } : {}");
    expect(editor).toContain("setExecutions([])");
    expect(editor).toContain("setHistoryLoading(true)");
    expect(editor).toContain("hasTransientRoutineExecution(next)");
    expect(editor).toContain("@openteam/product-core/statuses");
    expect(editor).toContain("setTimeout(() => void poll(), 1_500)");
    expect(editor).toContain("accessibilityLabel={label}");
  });

  test("hidden heavy sheets do no work and working controls remain accessible", async () => {
    const [route, settings, context, working] = await Promise.all([
      source("app/chat/[channelId].tsx"),
      source("app/settings.tsx"),
      source("src/state/openteam-context.tsx"),
      source("src/components/working-indicator.tsx"),
    ]);

    expect(route).not.toContain("RunActivitySheet");
    expect(route).not.toContain("Run activity");
    expect(settings).toContain("{pluginsOpen ? (");
    expect(settings).toContain(
      "<PluginManagerSheet onClose={() => setPluginsOpen(false)} visible />"
    );
    expect(context).toContain("if (durableSends.length === 0) return snapshot");
    expect(context).toContain("const rows = useMemo(");
    expect(working).toContain('accessibilityRole="progressbar"');
    expect(working).toContain('accessibilityRole="button"');
  });

  test("sending and opening attachments use one light haptic without changing other icon feedback", async () => {
    const [composer, iconButton] = await Promise.all([
      source("src/components/composer.tsx"),
      source("src/components/icon-button.tsx"),
    ]);

    expect(composer).toContain("void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);");
    expect(composer).toContain('label="Add attachment"');
    expect(composer).toContain('haptic="light"');
    expect(composer).toContain('accessibilityLabel="Attach Image"');
    expect(composer).toContain('accessibilityLabel="Take Photo"');
    expect(composer).toContain('accessibilityLabel="Choose File"');
    expect(composer).not.toContain("ActionSheetIOS.showActionSheetWithOptions");
    expect(composer).toMatch(/label="Send message"[\s\S]*?haptic="none"/);
    expect(composer).toMatch(/label="Transcribe and send"[\s\S]*?haptic="none"/);
    expect(iconButton).toContain('haptic = "selection"');
    expect(iconButton).toContain('haptic?: "selection" | "light" | "none"');
    expect(iconButton).toContain('if (haptic === "light")');
    expect(iconButton).toContain("void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);");
    expect(iconButton).toContain('else if (haptic === "selection")');
    expect(iconButton.match(/onPress\?\.\(\)/g)).toHaveLength(1);
  });

  test("mobile parity keeps voice, transfer lifecycle, rich rendering, previews, and auth-aware settings", async () => {
    const [composer, voice, upload, markdown, preview, bubble, settings] = await Promise.all([
      source("src/components/composer.tsx"),
      source("src/use-voice-input.ts"),
      source("src/native-asset-upload.ts"),
      source("src/components/advanced-markdown.dom.tsx"),
      source("src/components/attachment-preview.tsx"),
      source("src/components/message-bubble.tsx"),
      source("app/settings.tsx"),
    ]);

    expect(composer).toContain('label="Start voice input"');
    expect(composer).toContain('label="Stop recording"');
    expect(composer).toContain('label="Transcribe and send"');
    expect(composer).toContain("Retry upload");
    expect(composer).toContain("Cancel upload");
    expect(voice).toContain("MAX_RECORDING_MS = 300_000");
    expect(voice).toContain("MIN_RECORDING_MS = 500");
    expect(upload).toContain("createUploadTask");
    expect(upload).toContain("signal: input.signal");
    expect(markdown).toContain('securityLevel: "strict"');
    expect(markdown).toContain("DOMPurify.sanitize");
    expect(markdown).toContain("katex.renderToString");
    expect(preview).toContain("File.createDownloadTask");
    expect(preview).toContain("openPreview(localFile.uri)");
    expect(preview).toContain('presentationStyle="overFullScreen"');
    expect(preview).toContain("<MobileMarkdown");
    expect(preview).toContain("forceRich={documentPreview.content.length <= 128_000}");
    expect(preview).toContain("Share.share({ title: asset.fileName, url: documentPreview.uri })");
    expect(bubble).toContain("accessible={attachmentCount === 0}");
    expect(bubble).toContain("(files.length > 0 || stagedFiles.length > 0) && renderedContent");
    expect(settings).toContain('authMode === "disabled"');
    expect(settings).toContain("Not metered by self-hosted OpenTeam");
    expect(settings).toContain("Copy version info");
    expect(settings.indexOf("{accountParitySections}")).toBeLessThan(
      settings.indexOf('accessibilityLabel="Search Bot settings"')
    );
  });
});
