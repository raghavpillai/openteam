// A pending OS/keychain request must not leave the welcome screen spinning
// forever. Timing out does not delete credentials or cancel a native write.
export const readNativeAuthWithDeadline = <T>(request: Promise<T>, timeoutMs = 15_000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Secure sign-in storage did not respond. Please try signing in again.")), timeoutMs);
    request.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
