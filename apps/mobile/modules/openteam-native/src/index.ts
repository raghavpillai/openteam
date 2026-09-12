import {
  type EventSubscription,
  NativeModule,
  requireOptionalNativeModule,
} from "expo-modules-core";

export type SpeechState = "idle" | "requesting" | "recording" | "processing" | "error";

export interface VoiceRecording {
  uri: string;
  mimeType: string;
  durationMs: number;
}

interface SpeechLevelEvent {
  level: number;
}

interface SpeechErrorEvent {
  code: "permission" | "unavailable" | "interrupted" | "unknown";
  message: string;
}

type OpenTeamNativeEvents = {
  onSpeechLevel: (event: SpeechLevelEvent) => void;
  onSpeechError: (event: SpeechErrorEvent) => void;
};

declare class OpenTeamNativeModuleType extends NativeModule<OpenTeamNativeEvents> {
  startVoiceRecording(): Promise<void>;
  stopVoiceRecording(): Promise<VoiceRecording>;
  cancelVoiceRecording(): void;
  isCameraAvailable(): boolean;
  openPreview(uri: string): Promise<boolean>;
}

const nativeModule =
  requireOptionalNativeModule<OpenTeamNativeModuleType>("OpenTeamNative") ?? null;

export const openTeamNativeAvailable = nativeModule !== null;

export const voiceRecordingAvailable = typeof nativeModule?.startVoiceRecording === "function";
export const startVoiceRecording = async () => {
  if (!voiceRecordingAvailable) throw new Error("Update the OpenTeam app to record voice notes.");
  await nativeModule!.startVoiceRecording();
};
export const stopVoiceRecording = async (): Promise<VoiceRecording> => {
  if (!voiceRecordingAvailable) throw new Error("Recording is unavailable.");
  return nativeModule!.stopVoiceRecording();
};
export const cancelVoiceRecording = () => nativeModule?.cancelVoiceRecording?.();
export const isCameraAvailable = (): boolean | null => nativeModule?.isCameraAvailable() ?? null;
export const openPreview = async (uri: string): Promise<boolean> =>
  (await nativeModule?.openPreview(uri)) ?? false;

export const addSpeechLevelListener = (
  listener: OpenTeamNativeEvents["onSpeechLevel"]
): EventSubscription | null => nativeModule?.addListener("onSpeechLevel", listener) ?? null;

export const addSpeechErrorListener = (
  listener: OpenTeamNativeEvents["onSpeechError"]
): EventSubscription | null => nativeModule?.addListener("onSpeechError", listener) ?? null;
