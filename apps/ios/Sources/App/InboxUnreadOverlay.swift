import SwiftUI

struct InboxUnreadOverlay: View {
  let position: InboxUnreadPosition
  var usesSideToolbar = false
  let jump: (String) -> Void

  var body: some View {
    VStack(spacing: 0) {
      if let target = position.nearestAbove {
        chip(count: position.above.count, above: true, target: target)
      }
      Spacer(minLength: 0)
      if let target = position.nearestBelow {
        chip(count: position.below.count, above: false, target: target)
      }
    }
    .padding(.top, 12)
    .padding(.bottom, usesSideToolbar ? 29 : 12)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func chip(count: Int, above: Bool, target: String) -> some View {
    Button { jump(target) } label: {
      HStack(spacing: 8) {
        Text("\(count) unread")
        Image(systemName: above ? "chevron.up" : "chevron.down")
          .font(.system(size: 13, weight: .semibold))
      }
      .font(.system(size: 15, weight: .medium))
      .foregroundStyle(.white)
      .padding(.horizontal, 16)
      .frame(height: 38)
      .background(NativePalette.color("106ED3", "106ED3"), in: Capsule())
      .overlay {
        Capsule().strokeBorder(
          LinearGradient(colors: [Color(hex: "27A6FF"), Color(hex: "177FE8"), Color(hex: "1D89F9")],
            startPoint: .top, endPoint: .bottom), lineWidth: 0.7)
          .shadow(color: Color(hex: "008EFF").opacity(0.45), radius: 1)
      }
      // Shadow the opaque capsule as one layer, keeping its blue uniform
      // around the text instead of applying a shadow to each label separately.
      .compositingGroup()
      .shadow(color: .black.opacity(0.16), radius: 4, y: 2)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(count) unread \(above ? "above" : "below")")
    .accessibilityHint("Scroll to the nearest unread conversation")
    .accessibilityIdentifier(above ? "inbox-unread-above" : "inbox-unread-below")
  }
}
