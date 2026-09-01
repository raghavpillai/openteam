import {
  type EventSubscription,
  NativeModule,
  requireOptionalNativeModule,
} from "expo-modules-core";

export type SpeechState = "idle" | "requesting" | "recording" | "processing" | "error";

interface SpeechStateEvent {
  state: SpeechState;
}

interface SpeechResultEvent {
  transcript: string;
  final: boolean;
}

interface SpeechLevelEvent {
  level: number;
}

interface SpeechErrorEvent {
  code: "permission" | "unavailable" | "interrupted" | "unknown";
  message: string;
}

type OpenBotNativeEvents = {
  onSpeechState: (event: SpeechStateEvent) => void;
  onSpeechResult: (event: SpeechResultEvent) => void;
  onSpeechLevel: (event: SpeechLevelEvent) => void;
  onSpeechError: (event: SpeechErrorEvent) => void;
};

declare class OpenBotNativeModuleType extends NativeModule<OpenBotNativeEvents> {
  startSpeech(locale?: string): void;
  stopSpeech(): void;
  cancelSpeech(): void;
  isCameraAvailable(): boolean;
  openPreview(uri: string): Promise<boolean>;
}

const nativeModule = requireOptionalNativeModule<OpenBotNativeModuleType>("OpenBotNative") ?? null;

export const openBotNativeAvailable = nativeModule !== null;

export const startSpeech = (locale?: string) => nativeModule?.startSpeech(locale);
export const stopSpeech = () => nativeModule?.stopSpeech();
export const cancelSpeech = () => nativeModule?.cancelSpeech();
export const isCameraAvailable = (): boolean | null => nativeModule?.isCameraAvailable() ?? null;
export const openPreview = async (uri: string): Promise<boolean> =>
  (await nativeModule?.openPreview(uri)) ?? false;

export const addSpeechStateListener = (
  listener: OpenBotNativeEvents["onSpeechState"]
): EventSubscription | null => nativeModule?.addListener("onSpeechState", listener) ?? null;

export const addSpeechResultListener = (
  listener: OpenBotNativeEvents["onSpeechResult"]
): EventSubscription | null => nativeModule?.addListener("onSpeechResult", listener) ?? null;

export const addSpeechLevelListener = (
  listener: OpenBotNativeEvents["onSpeechLevel"]
): EventSubscription | null => nativeModule?.addListener("onSpeechLevel", listener) ?? null;

export const addSpeechErrorListener = (
  listener: OpenBotNativeEvents["onSpeechError"]
): EventSubscription | null => nativeModule?.addListener("onSpeechError", listener) ?? null;
