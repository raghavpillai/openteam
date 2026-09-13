// Disposable simulator entry. The physical microphone stays denied throughout.
import { registerRootComponent } from "expo";
import React, { useEffect, useRef, useState } from "react";
import { NativeModules, Text, View } from "react-native";
import { File, Paths } from "expo-file-system";
import { voiceRecordingAvailable } from "@openteam/mobile-native";
import { createOpenTeamAuthClient } from "@openteam/client-core/auth";
import { uploadNativeVoiceNote } from "../src/native-transcription-upload";
import { useVoiceInput } from "../src/use-voice-input";
import { Composer } from "../src/components/composer";
import { AppearanceProvider } from "../src/appearance";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { VoiceComposerQA } from "./voice-composer-native";

const origin = new URL(NativeModules.SourceCode.getConstants().scriptURL).origin;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
function QA() {
  const [text, setText] = useState("Testing native voice notes…");
  const [configured, setConfigured] = useState(false);
  const [finished, setFinished] = useState(false);
  const [composerQA, setComposerQA] = useState<React.ComponentProps<typeof VoiceComposerQA> | null>(
    null
  );
  const voice = useVoiceInput(
    () => undefined,
    configured,
    async () => {
      throw new Error("Permission must remain denied");
    }
  );
  const latest = useRef(voice);
  latest.current = voice;
  useEffect(() => {
    const run = async () => {
      const reports: string[] = [];
      let file: File | undefined;
      try {
        assert(voiceRecordingAvailable, "Rebuilt native recorder is missing");
        assert(!latest.current.available, "Voice input available without transcription setup");
        latest.current.start();
        await pause(100);
        assert(latest.current.state === "idle", "Unconfigured voice input started recording");
        reports.push("native hook stays disabled without setup");
        setConfigured(true);
        await pause(100);
        latest.current.start();
        const deadline = Date.now() + 15_000;
        while (latest.current.state !== "error" && Date.now() < deadline) await pause(50);
        assert(
          latest.current.error?.includes("Allow microphone access"),
          `Microphone permission failure missing: ${latest.current.error}`
        );
        latest.current.cancel();
        reports.push("native recorder rejects denied microphone permission with a useful message");
        const config = await (await fetch(`${origin}/qa-config`)).json();
        const auth = createOpenTeamAuthClient({ baseUrl: config.serverUrl });
        const { token } = await auth.signIn(config.username, config.password);
        file = await File.createDownloadTask(
          `${origin}/fixture.wav`,
          new File(Paths.cache, "openteam-qa-voice.wav"),
          { sessionType: "foreground" }
        ).downloadAsync();
        assert(file?.exists, "Native fixture download failed");
        const start = Date.now();
        const result = await uploadNativeVoiceNote({
          serverUrl: config.serverUrl,
          file: file!,
          authToken: token,
          signal: new AbortController().signal,
        });
        assert(
          result.text.toLowerCase().includes("project update tomorrow morning"),
          `Unexpected native transcript: ${result.text}`
        );
        const transcriptionMs = Date.now() - start;
        reports.push("real Expo native WAV upload → authenticated server → Parakeet");
        const composer = await new Promise<{
          reports: string[];
          deliveries: Array<{ botId: string; clientId: string; text: string }>;
        }>((resolve, reject) => {
          setComposerQA({
            serverUrl: config.serverUrl,
            token,
            origin,
            onDone: (result) => {
              setComposerQA(null);
              if (result instanceof Error) reject(result);
              else resolve(result);
            },
          });
        });
        reports.push(...composer.reports);
        // Revoke the real session: NSURLSession can retain the valid login
        // cookie, so replacing only the Authorization header is not a logout.
        await auth.signOut(token);
        assert(
          (await auth.getSession(token)) === null,
          "Sign-out failed to revoke the test session"
        );
        let unauthorized = false;
        try {
          await uploadNativeVoiceNote({
            serverUrl: config.serverUrl,
            file: file!,
            authToken: token,
            signal: new AbortController().signal,
            onUnauthorized: () => {
              unauthorized = true;
            },
          });
          throw new Error("Invalid native auth was accepted");
        } catch (error) {
          assert(unauthorized, `Invalid auth did not trigger reauthentication: ${String(error)}`);
        }
        reports.push("native upload reports an expired session");
        const renewed = await auth.signIn(config.username, config.password);
        const abort = new AbortController();
        abort.abort();
        let cancelled = false;
        try {
          await uploadNativeVoiceNote({
            serverUrl: config.serverUrl,
            file: file!,
            authToken: renewed.token,
            signal: abort.signal,
          });
        } catch {
          cancelled = true;
        }
        assert(cancelled, "Cancelled native upload returned text");
        file!.delete();
        assert(!file!.exists, "Temporary recording was not deleted");
        reports.push("native upload cancellation and temporary-file removal");
        const report = {
          reports,
          text: result.text,
          transcriptionMs,
          deliveries: composer.deliveries,
        };
        setText(JSON.stringify(report, null, 2));
        setFinished(true);
        await pause(250);
        await fetch(`${origin}/qa-report`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(report),
        });
      } catch (error) {
        const report = { reports, error: String(error) };
        setText(JSON.stringify(report, null, 2));
        await fetch(`${origin}/qa-report`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(report),
        });
      } finally {
        if (file?.exists) file.delete();
      }
    };
    void run();
  }, []);
  return (
    <View style={{ flex: 1, padding: 30, paddingTop: 90, backgroundColor: "white" }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: "black", fontSize: 13 }}>{text}</Text>
      </View>
      {composerQA ? <VoiceComposerQA {...composerQA} /> : null}
      {finished ? (
        <Composer
          draftKey="voice-note-native-qa"
          botName="Voice QA"
          replyTarget={null}
          replyEditVersion={0}
          onRestoreReply={() => undefined}
          onClearReply={() => undefined}
          onSend={async () => {
            throw new Error("Do not send test messages");
          }}
          onStage={async () => {
            throw new Error("No test attachments");
          }}
          onUpload={async () => {
            throw new Error("No test attachments");
          }}
          assetUrl={() => null}
          transcriptionConfigured={false}
          onTranscribe={async () => {
            throw new Error("Transcription is disabled");
          }}
        />
      ) : null}
    </View>
  );
}
function Root() {
  return (
    <SafeAreaProvider>
      <AppearanceProvider>
        <QA />
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}
registerRootComponent(Root);
