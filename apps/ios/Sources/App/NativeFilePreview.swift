import QuickLook
import SwiftUI

struct NativeFilePreview: View {
  @Environment(\.dismiss) private var dismiss
  let url: URL
  var mimeType: String = ""
  @State private var sharing = false
  @State private var shareError: String?
  @State private var rowCount: Int?
  @State private var barRegions = BarRegions.none
  /// Wide displays such as an unfolded iPhone Duo show the document as a floating card
  /// almost as wide as the display; the system sheet there is a narrow form card.
  var floating = false
  var body: some View {
    if floating {
      FloatingDocumentCard { close in document(close: close, topPadding: 16, sideBar: nil) }
    } else {
      GeometryReader { proxy in
        // On iPhone Duo's outer display, Close and Share move into the side region under
        // the status bar, as the chat's controls do, so the title gets the whole top row.
        let side = SideChrome(regions: barRegions, insets: proxy.safeAreaInsets, holdsAllControls: true)
        document(close: { dismiss() }, topPadding: 14, sideBar: side)
      }
      .readingBarRegions { barRegions = $0 }
      .displayAwareSheet().presentationDragIndicator(.visible)
    }
  }
  private func closeButton(_ close: @escaping () -> Void) -> some View {
    ChromeButton(title: "Close", symbol: "xmark") { close() }
      .accessibilityIdentifier("file-preview-close")
  }
  private var shareButton: some View {
    ChromeButton(title: "Share", symbol: "square.and.arrow.up") {
      NativeHaptics.play(.light, source: "attachment.share")
      sharing = true
    }.accessibilityIdentifier("file-preview-share")
  }
  private func document(close: @escaping () -> Void, topPadding: CGFloat, sideBar: SideChrome?)
    -> some View
  {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        if sideBar == nil { closeButton(close) }
        Text(url.lastPathComponent).font(.body.weight(.medium)).lineLimit(1)
          .truncationMode(.middle).frame(maxWidth: .infinity)
        if let rowCount {
          Text(rowCount == 1 ? "1 row" : "\(rowCount.formatted()) rows")
            .font(.system(size: 13)).monospacedDigit().foregroundStyle(NativePalette.muted)
            .fixedSize().accessibilityIdentifier("file-preview-rows")
        }
        if sideBar == nil { shareButton }
      }
      // Line the buttons up with the value bar and grid below, which start 12 pt in.
      .padding(.horizontal, 12).padding(.top, topPadding)
      .frame(minHeight: sideBar == nil ? 0 : 44 + topPadding, alignment: .bottom)
      ZStack {
        if isSpreadsheet {
          SpreadsheetPreview(url: url) { rowCount = $0.totalRows }
            .padding(.top, 8)
        } else if canPreview {
          QuickLookDocument(url: url)
        } else {
          VStack(spacing: 12) {
            Image(systemName: "doc").font(.system(size: 24)).foregroundStyle(NativePalette.faint)
            Text("This file type can't be previewed here.\nShare it to open elsewhere.")
              .font(.system(size: 15)).foregroundStyle(NativePalette.muted)
              .multilineTextAlignment(.center)
          }.padding(24).accessibilityIdentifier("file-preview-unavailable")
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .modifier(SideChromeBar(top: EmptyView?.none, side: VStack(spacing: 10) {
      closeButton(close)
      shareButton
      Spacer(minLength: 12)
    }))
    .environment(\.sideChrome, sideBar)
    .sheet(isPresented: $sharing) {
      NativeFileShare(url: url) { error in
        NativeHaptics.failure(error, source: "attachment.share")
        shareError = UserFacingError.message(error)
      }
    }
    .alert(
      "Couldn’t share file",
      isPresented: Binding(get: { shareError != nil }, set: { if !$0 { shareError = nil } })
    ) {
      Button("OK") { shareError = nil }
    } message: {
      Text(shareError ?? "")
    }
  }
  /// Whether documents should open as a floating card rather than a sheet.
  @MainActor static var prefersFloatingCard: Bool {
    let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }?.keyWindow
    return (window?.bounds.width ?? 0) > 700
  }
  private var isSpreadsheet: Bool {
    SpreadsheetTable.canPreview(fileName: url.lastPathComponent, mimeType: mimeType)
  }
  private var canPreview: Bool {
    let archive = ["zip", "tar", "gz", "7z", "rar"].contains(url.pathExtension.lowercased())
    return !archive && QLPreviewController.canPreview(url as NSURL)
  }
}
/// A document card floating over a dimmed window, presented without the system's slide so
/// the dim fades in place while the card rises. Tap outside, Close, or drag the grabber down
/// to dismiss.
private struct FloatingDocumentCard<Content: View>: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shown = false
  @State private var drag: CGFloat = 0
  @ViewBuilder var content: (_ close: @escaping () -> Void) -> Content
  private let shape = RoundedRectangle(cornerRadius: 34, style: .continuous)

  var body: some View {
    GeometryReader { proxy in
      ZStack {
        Color.black.opacity(shown ? 0.42 * (1 - min(1, drag / 400)) : 0).ignoresSafeArea()
          .contentShape(Rectangle())
          .onTapGesture { close() }
          .accessibilityElement()
          .accessibilityLabel("Dismiss")
          .accessibilityAddTraits(.isButton)
          .accessibilityAction { close() }
          .accessibilityIdentifier("file-preview-backdrop")
        content(close)
          .background(NativePalette.background)
          .clipShape(shape)
          .overlay(alignment: .top) { grabber }
          .shadow(color: .black.opacity(0.28), radius: 30, y: 12)
          .frame(maxWidth: min(1_100, proxy.size.width - 96))
          .padding(.vertical, 18)
          .offset(y: shown ? max(0, drag) : proxy.size.height + 40)
          .accessibilityAddTraits(.isModal)
      }
    }
    .presentationBackground(.clear)
    .onAppear {
      withAnimation(reduceMotion ? nil : .spring(duration: 0.5, bounce: 0.1)) { shown = true }
    }
  }

  private var grabber: some View {
    Capsule().fill(NativePalette.faint.opacity(0.7)).frame(width: 40, height: 5)
      .frame(maxWidth: .infinity).frame(height: 22).contentShape(Rectangle())
      .gesture(
        DragGesture()
          .onChanged { drag = max(0, $0.translation.height) }
          .onEnded { value in
            if value.translation.height > 140 || value.predictedEndTranslation.height > 420 {
              close()
            } else {
              withAnimation(.spring(duration: 0.35, bounce: 0.2)) { drag = 0 }
            }
          }
      )
      .accessibilityElement()
      .accessibilityLabel("Drag down to close")
      .accessibilityAction { close() }
      .accessibilityIdentifier("file-preview-grabber")
  }

  private func close() {
    guard shown else { return }
    withAnimation(reduceMotion ? nil : .easeIn(duration: 0.24)) { shown = false } completion: {
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) { dismiss() }
    }
  }
}

private struct QuickLookDocument: UIViewControllerRepresentable {
  let url: URL
  func makeCoordinator() -> Coordinator { Coordinator(url: url) }
  func makeUIViewController(context: Context) -> QLPreviewController {
    let view = QLPreviewController()
    view.dataSource = context.coordinator
    return view
  }
  func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    let url: URL
    init(url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> any QLPreviewItem
    { url as NSURL }
  }
}

struct NativeFileShare: UIViewControllerRepresentable {
  let url: URL
  var onFailure: (Error) -> Void
  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    controller.completionWithItemsHandler = { _, _, _, error in
      if let error { Task { @MainActor in onFailure(error) } }
    }
    return controller
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
