import SwiftUI

/// The model and voice providers' official icons, from the asset catalog: the ChatGPT
/// and Claude app icons where a choice means "your plan", and vector marks and tiles
/// for API providers. The black marks are template images, so they follow `.primary`.
struct ProviderMark: View {
  enum Kind: Hashable { case chatgpt, claude, openai, anthropic, openrouter, deepgram, key, other }
  enum Style {
    /// The bare mark: small inline marks, API providers, voice services.
    case mark
    /// A square icon with continuous corners: an app icon, or a mark on a tile.
    case icon
    /// The app icon for a ChatGPT or Claude plan, the mark for anything else.
    case natural
  }
  let kind: Kind
  var size: CGFloat = 28
  var style: Style = .mark
  var body: some View {
    ProviderGlyph(kind: kind, style: style).frame(width: size, height: size)
  }

  static func kind(for providerId: String) -> Kind {
    switch providerId {
    case "openai-codex": return .chatgpt
    case "claude-code": return .claude
    case "openai": return .openai
    case "anthropic": return .anthropic
    case "openrouter": return .openrouter
    case "deepgram": return .deepgram
    case "api-key": return .key
    default: return .other
    }
  }

  static func kind(for voice: TranscriptionSettings.Provider) -> Kind {
    switch voice {
    case .openai: return .openai
    case .deepgram: return .deepgram
    case .compatible: return .other
    }
  }
}

/// A provider icon that fills the square it's given, so a shared-element move can
/// resize it smoothly. `ProviderMark` gives it a fixed size.
struct ProviderGlyph: View {
  let kind: ProviderMark.Kind
  var style: ProviderMark.Style = .mark

  var body: some View {
    Group {
      switch resolved {
      case .icon: icon
      case .mark, .natural: mark
      }
    }
    .aspectRatio(1, contentMode: .fit)
    .accessibilityHidden(true)
  }

  private var resolved: ProviderMark.Style {
    guard style == .natural else { return style }
    return [.chatgpt, .claude].contains(kind) ? .icon : .mark
  }

  @ViewBuilder private var mark: some View {
    switch kind {
    case .chatgpt, .openai: template("Provider-openai")
    case .claude: Image("Provider-claude").resizable().scaledToFit()
    case .anthropic: template("Provider-anthropic")
    case .openrouter: template("Provider-openrouter")
    case .deepgram: template("Provider-deepgram")
    case .key: symbol("key.fill", color: Color(hex: "C08A1E")).rotationEffect(.degrees(-45))
    case .other: symbol("sparkles", color: WizardStage.model.accent)
    }
  }

  @ViewBuilder private var icon: some View {
    ZStack {
      switch kind {
      case .chatgpt: Image("Provider-chatgpt-app").resizable().interpolation(.high)
      case .claude: Image("Provider-claude-app").resizable().interpolation(.high)
      case .anthropic: Image("Provider-anthropic-tile").resizable()
      case .openrouter: Image("Provider-openrouter-tile").resizable()
      case .deepgram: Image("Provider-deepgram-tile").resizable()
      case .openai:
        WizardPalette.card
        template("Provider-openai").scaleEffect(0.62)
      case .key:
        NativePalette.color("FBF4E4", "2A2414")
        symbol("key.fill", color: Color(hex: "C08A1E")).rotationEffect(.degrees(-45))
          .scaleEffect(0.56)
      case .other:
        WizardPalette.card
        symbol("sparkles", color: WizardStage.model.accent).scaleEffect(0.56)
      }
    }
    .clipShape(ProviderIconShape())
    .overlay { ProviderIconShape().stroke(Color.primary.opacity(0.09), lineWidth: 0.75) }
  }

  private func template(_ name: String) -> some View {
    Image(name).renderingMode(.template).resizable().scaledToFit().foregroundStyle(.primary)
  }

  private func symbol(_ name: String, color: Color) -> some View {
    Image(systemName: name).resizable().scaledToFit().fontWeight(.semibold).foregroundStyle(color)
  }
}

/// An iOS app-icon corner: continuous, at about 22% of the side.
struct ProviderIconShape: Shape {
  func path(in rect: CGRect) -> Path {
    RoundedRectangle(cornerRadius: min(rect.width, rect.height) * 0.225, style: .continuous)
      .path(in: rect)
  }
}
