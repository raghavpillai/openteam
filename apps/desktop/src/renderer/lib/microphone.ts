export const MICROPHONE_STORAGE_KEY = "openteam:microphone";
export const MICROPHONE_CHANGE_EVENT = "openteam:microphone-change";
export const MICROPHONE_ACCESS_EVENT = "openteam:microphone-access";

// Hardware identifiers belong to this client, never to server/account settings.
export const readMicrophonePreference = (): string => {
  try {
    return localStorage.getItem(MICROPHONE_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
};

export const setMicrophonePreference = (deviceId: string): void => {
  if (deviceId) localStorage.setItem(MICROPHONE_STORAGE_KEY, deviceId);
  else localStorage.removeItem(MICROPHONE_STORAGE_KEY);
  window.dispatchEvent(new Event(MICROPHONE_CHANGE_EVENT));
};

export const subscribeMicrophonePreference = (listener: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === MICROPHONE_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(MICROPHONE_CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(MICROPHONE_CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
};

export const microphoneErrorMessage = (error: unknown): string => {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Allow microphone access in system settings to record a voice note.";
    case "NotFoundError":
      return "No microphone found. Connect a microphone and try again.";
    case "NotReadableError":
      return "The microphone is unavailable or in use. Check its connection and close other audio apps, then try again.";
    case "OverconstrainedError":
      return "This microphone could not be used. Choose another microphone in General settings.";
    default:
      return "Could not start the microphone. Check its connection and try again.";
  }
};

export const MICROPHONE_DISCONNECTED = "Microphone disconnected. Reconnect it and try again.";
export const MICROPHONE_FALLBACK = "Selected microphone unavailable. Using system default.";

/** Only invoked after an explicit record/test action. Never records or uploads audio itself. */
export async function openMicrophone(
  options: { deviceId?: string; signal?: AbortSignal } = {}
): Promise<{ stream: MediaStream; usedFallback: boolean }> {
  const { deviceId = readMicrophonePreference(), signal } = options;
  signal?.throwIfAborted();
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) throw new Error("Microphone capture is unavailable.");
  let stream: MediaStream;
  let usedFallback = false;
  try {
    stream = await devices.getUserMedia({
      audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio,
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (
      !deviceId ||
      !(error instanceof Error) ||
      !["NotFoundError", "NotReadableError", "OverconstrainedError"].includes(error.name)
    )
      throw error;
    stream = await devices.getUserMedia({ audio });
    usedFallback = true;
  }
  // getUserMedia cannot be aborted. Release a late permission result immediately.
  if (signal?.aborted) {
    stream.getTracks().forEach((track) => track.stop());
    signal.throwIfAborted();
  }
  window.dispatchEvent(new Event(MICROPHONE_ACCESS_EVENT));
  return { stream, usedFallback };
}
