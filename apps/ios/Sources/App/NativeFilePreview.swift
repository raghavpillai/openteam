import QuickLook
import SwiftUI

struct NativeFilePreview: View {
  @Environment(\.dismiss) private var dismiss
  let url: URL
  var mimeType: String = ""
  @State private var sharing = false
  @State private var shareError: String?
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        ChromeButton(title: "Close", symbol: "xmark") { dismiss() }
          .accessibilityIdentifier("file-preview-close")
        Text(url.lastPathComponent).font(.body.weight(.medium)).lineLimit(1)
          .truncationMode(.middle).frame(maxWidth: .infinity)
        ChromeButton(title: "Share", symbol: "square.and.arrow.up") {
          NativeHaptics.play(.light, source: "attachment.share")
          sharing = true
        }.accessibilityIdentifier("file-preview-share")
      }.padding(.horizontal, 16).padding(.top, 16)
      ZStack {
        if canPreview {
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
    }.nativeCanvas().referenceSheet().presentationDragIndicator(.visible)
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
  private var canPreview: Bool {
    let archive = ["zip", "tar", "gz", "7z", "rar"].contains(url.pathExtension.lowercased())
    return !archive && QLPreviewController.canPreview(url as NSURL)
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
