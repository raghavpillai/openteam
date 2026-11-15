import UIKit

/// Asks iOS to keep the app running for a short while after the user switches away, so work
/// they already started, like a voice note being transcribed and sent, finishes instead of
/// waiting for them to come back. iOS usually allows about 30 seconds.
@MainActor
enum BackgroundTime {
  /// Starts a request and returns the call that ends it. Ending it again does nothing.
  /// Tests replace this to check that every request ends.
  static var begin: @MainActor (_ name: String) -> @MainActor () -> Void = { name in
    let request = Request()
    request.start(name)
    return { request.end() }
  }

  /// iOS terminates an app that still holds a request when its time runs out, so a request
  /// ends as soon as iOS says time is up, even if that happens while it's being started.
  @MainActor
  private final class Request {
    private var id = UIBackgroundTaskIdentifier.invalid
    private var ended = false

    func start(_ name: String) {
      // Starting with only moments left buys nothing, and iOS terminates an app whose request
      // outlives them. In the foreground the time remaining is unlimited.
      guard UIApplication.shared.backgroundTimeRemaining > 5 else { return }
      let id = UIApplication.shared.beginBackgroundTask(withName: name) { self.end() }
      self.id = id
      // Time can run out before the identifier is known; end the request now if it did.
      if ended { finish() }
    }

    func end() {
      ended = true
      finish()
    }

    private func finish() {
      guard id != .invalid else { return }
      UIApplication.shared.endBackgroundTask(id)
      id = .invalid
    }
  }
}
