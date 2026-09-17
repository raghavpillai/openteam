import Observation
import SwiftUI

@MainActor @Observable final class FormOperation {
  var busy = false
  var failure: String?
  var success: String?
  @discardableResult func run(
    success message: String? = nil, feedback: Bool = true, successEffect: HapticEffect? = .success,
    _ operation: () async throws -> Void
  )
    async -> Bool
  {
    guard !busy else { return false }
    busy = true
    failure = nil
    success = nil
    defer { busy = false }
    do {
      try await operation()
      try Task.checkCancellation()
      success = message
      if feedback, let successEffect { NativeHaptics.play(successEffect, source: "form.result") }
      return true
    } catch {
      if !UserFacingError.isCancelled(error) {
        failure = UserFacingError.message(error)
        if feedback { NativeHaptics.failure(error, source: "form.result") }
      }
      return false
    }
  }
}

struct FormStatus: View {
  let operation: FormOperation
  var body: some View {
    if operation.busy { ProgressView("Working…") }
    if let failure = operation.failure { InlineFailure(message: failure) }
    if let success = operation.success {
      Label(success, systemImage: "checkmark.circle").foregroundStyle(NativePalette.muted).font(
        .subheadline)
    }
  }
}
