// Simulator-only fixture: synthetic capture, actual React Native composer/upload/chat client.
import React, { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { requireNativeModule } from "expo-modules-core";
import { File, Paths } from "expo-file-system";
import { createOpenTeamClient } from "@openteam/client-core";
import { Composer } from "../src/components/composer";
import { uploadNativeVoiceNote } from "../src/native-transcription-upload";
import { ThreadSheet } from "../src/components/thread-sheet";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";

const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
export function VoiceComposerQA({
  serverUrl,
  token,
  origin,
  onDone,
}: {
  serverUrl: string;
  token: string;
  origin: string;
  onDone: (
    result:
      | { reports: string[]; deliveries: Array<{ botId: string; clientId: string; text: string }> }
      | Error
  ) => void;
}) {
  const host = useRef<any>(null);
  const target = useRef<any>(null);
  const threadRoot = useRef<any>(null);
  const [inThread, setInThread] = useState(false);
  const deliveries = useRef<Array<{ botId: string; clientId: string; text: string }>>([]);
  const client = useRef(
    createOpenTeamClient({ baseUrl: serverUrl, getAuthToken: () => token })
  ).current;
  const uploadMode = useRef<"normal" | "failure" | "delayed">("normal");
  const resolveLate = useRef<((value: { text: string }) => void) | null>(null);
  const uploadSignal = useRef<AbortSignal | null>(null);
  const rootFiber = () => {
    let node = host.current?.__internalInstanceHandle ?? host.current?._internalInstanceHandle;
    while (node?.return) node = node.return;
    return node?.stateNode?.current ?? node;
  };
  const props = (predicate: (props: any) => boolean): any => {
    const walk = (node: any): any => {
      if (!node) return null;
      if (node.memoizedProps && predicate(node.memoizedProps)) return node.memoizedProps;
      return walk(node.child) ?? walk(node.sibling);
    };
    return walk(rootFiber());
  };
  const press = async (label: string) => {
    const found = props(
      (p) =>
        (p.label === label || p.accessibilityLabel === label) && typeof p.onPress === "function"
    );
    assert(found && !found.disabled, `Missing/enabled control: ${label}`);
    found.onPress();
    await pause();
  };
  const editor = () =>
    props(
      (p) =>
        ["Message Voice QA", "Reply Voice QA"].includes(p.accessibilityLabel) &&
        typeof p.onChangeText === "function"
    );
  const capture = async (name: string) => {
    await pause(200);
    await fetch(`${origin}/qa-capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  };
  const waitFor = async (ready: () => boolean, label: string) => {
    const deadline = Date.now() + 90_000;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await pause();
    }
  };
  useEffect(() => {
    const native = requireNativeModule("OpenTeamNative");
    const originals = {
      start: native.startVoiceRecording,
      stop: native.stopVoiceRecording,
      cancel: native.cancelVoiceRecording,
    };
    let recording: File | null = null;
    const run = async () => {
      const reports: string[] = [];
      try {
        target.current = await client.createBot({
          name: "Native Voice QA",
          clientRequestId: `native-voice-${Date.now()}`,
        });
        native.startVoiceRecording = async () => {
          recording = await File.createDownloadTask(
            `${origin}/fixture.wav`,
            new File(Paths.cache, `qa-${Date.now()}.wav`),
            { sessionType: "foreground" }
          ).downloadAsync();
        };
        native.stopVoiceRecording = async () => ({
          uri: recording!.uri,
          mimeType: "audio/wav",
          durationMs: 1500,
        });
        native.cancelVoiceRecording = () => {
          if (recording?.exists) recording.delete();
          recording = null;
        };
        await waitFor(() => Boolean(editor()), "native composer");
        editor().onChangeText("Prefix OLD suffix.");
        await pause();
        editor().ref?.current?.setNativeProps({ selection: { start: 7, end: 10 } });
        editor().onSelectionChange({ nativeEvent: { selection: { start: 7, end: 10 } } });
        await pause();
        await press("Start voice input");
        await waitFor(
          () =>
            Boolean(
              props(
                (p) => p.label === "Stop recording" || p.accessibilityLabel === "Stop recording"
              )
            ),
          "recording controls"
        );
        await capture("recording");
        await press("Stop recording");
        await waitFor(
          () => Boolean(editor()?.value.includes("project update")),
          "live transcript in native composer"
        );
        const text = editor().value;
        await capture("draft");
        assert(
          text.startsWith("Prefix Please") && text.endsWith(" suffix."),
          `Cursor replacement failed: ${text}`
        );
        assert(deliveries.current.length === 0, "Stop sent without review");
        assert(
          props((p) => p.label === "Start voice input"),
          "Mic vanished after dictation"
        );
        const sendControl = props((p) => p.label === "Send message");
        sendControl.onPress();
        sendControl.onPress();
        await waitFor(() => deliveries.current.length === 1, "native chat delivery");
        assert(deliveries.current[0]!.text === text, "Submitted native text changed");
        reports.push(
          "native composer replaces selection, keeps mic available, and sends reviewed text exactly once through real chat HTTP"
        );

        uploadMode.current = "delayed";
        await press("Start voice input");
        await waitFor(
          () =>
            Boolean(
              props(
                (p) => p.label === "Stop recording" || p.accessibilityLabel === "Stop recording"
              )
            ),
          "second recording"
        );
        await press("Transcribe and send");
        await waitFor(() => Boolean(resolveLate.current), "pending transcription");
        await press("Cancel voice note");
        assert(uploadSignal.current?.aborted, "Cancel failed to abort native upload");
        resolveLate.current!({ text: "Cancelled text must never be sent" });
        await pause(250);
        assert(
          deliveries.current.length === 1 && !editor()?.value.includes("Cancelled"),
          "Cancelled result sent or edited a draft"
        );
        reports.push("native composer cancels queued send and ignores a late transcription");

        uploadMode.current = "failure";
        await press("Start voice input");
        await waitFor(
          () => Boolean(props((p) => p.accessibilityLabel === "Stop recording")),
          "retry recording"
        );
        await press("Transcribe and send");
        await waitFor(
          () => Boolean(props((p) => p.accessibilityLabel === "Retry transcription")),
          "retry action"
        );
        uploadMode.current = "normal";
        await press("Retry transcription");
        await waitFor(() => Boolean(editor()?.value.includes("project update")), "retry draft");
        assert(deliveries.current.length === 1, "Retry sent without review");
        reports.push(
          "failed native voice send retains audio; retry transcribes into a draft without sending"
        );

        uploadMode.current = "normal";
        setInThread(true);
        await waitFor(() => editor()?.accessibilityLabel === "Reply Voice QA", "thread composer");
        await press("Start voice input");
        await waitFor(
          () =>
            Boolean(
              props(
                (p) => p.label === "Stop recording" || p.accessibilityLabel === "Stop recording"
              )
            ),
          "third recording"
        );
        await capture("thread-recording");
        await press("Transcribe and send");
        await waitFor(() => deliveries.current.length === 2, "explicit native voice send");
        await pause(250);
        assert(deliveries.current.length === 2, "Explicit voice send duplicated");
        reports.push(
          "actual native thread composer transcribes and sends exactly once to the original reply target"
        );
        let grant: (() => void) | undefined;
        native.startVoiceRecording = () =>
          new Promise<void>((resolve) => {
            grant = resolve;
          });
        await press("Start voice input");
        (AppState as any)._emitter.emit("appStateDidChange", { app_state: "inactive" });
        await pause();
        assert(
          props((p) => p.accessibilityLabel === "Requesting microphone"),
          "Permission sheet cancelled its own request"
        );
        (AppState as any)._emitter.emit("appStateDidChange", { app_state: "background" });
        await pause();
        grant!();
        (AppState as any)._emitter.emit("appStateDidChange", { app_state: "active" });
        await pause(250);
        assert(
          !props((p) => p.accessibilityLabel === "Stop recording"),
          "Late permission started recording in the background"
        );
        assert(deliveries.current.length === 2, "Background cancellation sent a message");
        reports.push(
          "native hook tolerates permission-sheet inactivity and cancels backgrounded pending capture"
        );
        onDone({ reports, deliveries: deliveries.current });
      } catch (error) {
        onDone(error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (recording?.exists) recording.delete();
        native.startVoiceRecording = originals.start;
        native.stopVoiceRecording = originals.stop;
        native.cancelVoiceRecording = originals.cancel;
      }
    };
    void run();
  }, []);
  const transcribe = async (uri: string, signal: AbortSignal): Promise<{ text: string }> => {
    uploadSignal.current = signal;
    if (uploadMode.current === "failure") throw new Error("Provider unavailable");
    if (uploadMode.current === "delayed")
      return new Promise((resolve) => {
        resolveLate.current = resolve;
      });
    return uploadNativeVoiceNote({ serverUrl, authToken: token, file: new File(uri), signal });
  };
  const send = async (content: string, attachments: any[], replyToMessageId?: string) => {
    const clientId = `native-voice-send-${Date.now()}`;
    const result = await client.sendDirectMessage(
      target.current.conversationId,
      content,
      attachments,
      replyToMessageId,
      { clientId, ...(replyToMessageId ? { isFork: true } : {}) }
    );
    if (replyToMessageId)
      assert(
        (result.message.metadata as any)?.replyTo === threadRoot.current.id,
        "Thread reply target changed"
      );
    else threadRoot.current = result.message;
    deliveries.current.push({ botId: target.current.id, clientId, text: content });
  };
  return (
    <View ref={host}>
      {inThread ? (
        <ThreadSheet
          transcriptionConfigured
          onTranscribe={transcribe}
          assetUrl={() => null}
          botById={new Map()}
          botName="Voice QA"
          draftKey="native-voice-thread-qa"
          historyHasMore={false}
          historyLoading={false}
          mentionOptions={[]}
          onClose={() => setInThread(false)}
          onLoadEarlier={async () => undefined}
          onLoadLater={async () => undefined}
          historyHasNewer={false}
          onVisibleMessageIds={() => undefined}
          onReact={async () => undefined}
          onResendFailed={async () => undefined}
          onDeleteFailed={async () => undefined}
          onCancelQueued={async () => null}
          deliveryRecoveries={[]}
          onAcknowledgeRecovery={async () => undefined}
          onSecretSubmit={async () => false}
          onComputerHandoff={async () => true}
          onSend={(content, attachments, _staged, replyTo) =>
            send(content, [...attachments], replyTo)
          }
          onUpload={async () => {
            throw new Error("Unexpected attachment");
          }}
          onVisibleSequence={() => undefined}
          onWidgetDismiss={async () => true}
          onWidgetResponse={async () => true}
          thread={{ root: threadRoot.current, replies: [] }}
          uploadCapabilities={CLIENT_CAPABILITIES.uploads}
        />
      ) : (
        <Composer
          draftKey="native-voice-composer-qa"
          botName="Voice QA"
          replyTarget={null}
          replyEditVersion={0}
          onRestoreReply={() => undefined}
          onClearReply={() => undefined}
          transcriptionConfigured
          onTranscribe={transcribe}
          onSend={async (content, attachments) => {
            await send(content, attachments);
          }}
          onStage={async () => {
            throw new Error("Unexpected voice attachment");
          }}
          onUpload={async () => {
            throw new Error("Unexpected voice attachment");
          }}
          assetUrl={() => null}
        />
      )}
    </View>
  );
}
