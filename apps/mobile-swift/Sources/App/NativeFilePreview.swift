import QuickLook
import SwiftUI

struct NativeFilePreview: View {
  @Environment(\.dismiss) private var dismiss
  let url: URL
  @State private var sharing = false
  @State private var shareError: String?
  var body: some View {
    NavigationStack {
      QuickLookDocument(url: url)
        .navigationTitle(url.lastPathComponent).navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
          ToolbarItem(placement: .topBarLeading) {
            Button("Share", systemImage: "square.and.arrow.up") {
              NativeHaptics.play(.light, source: "attachment.share")
              sharing = true
            }.labelStyle(.iconOnly)
          }
        }.toolbar(.visible, for: .navigationBar)
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

private struct NativeFileShare: UIViewControllerRepresentable {
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
