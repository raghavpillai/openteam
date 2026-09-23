#if DEBUG
import SwiftUI
import UIKit

/// Opt-in timing probe. Buffers on the main thread; writes only after the transition.
struct ComposerLatencyProbe: UIViewRepresentable {
  func makeUIView(context: Context) -> ProbeView { ProbeView() }
  func updateUIView(_ view: ProbeView, context: Context) {}

  final class TouchObserver: UIGestureRecognizer {
    var observe: (String, UITouch) -> Void = { _, _ in }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
      if let touch = touches.first { observe("touchDown", touch) }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
      if let touch = touches.first { observe("touchUp", touch) }
      state = .failed
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }
    override func canPrevent(_ other: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by other: UIGestureRecognizer) -> Bool { false }
  }
  final class ProbeView: UIView {
    private var observer: TouchObserver?
    private var link: CADisplayLink?
    private var events: [[String: Any]] = []
    private var frames: [[Double]] = []
    private var generation = 0
    override func didMoveToWindow() {
      super.didMoveToWindow()
      guard let window, observer == nil else { return }
      let observer = TouchObserver()
      observer.cancelsTouchesInView = false
      observer.delaysTouchesBegan = false
      observer.delaysTouchesEnded = false
      observer.observe = { [weak self] name, touch in
        guard let self else { return }
        let p = touch.location(in: self.window)
        self.events.append(["event": name, "time": CACurrentMediaTime(),
          "touchTime": touch.timestamp, "x": p.x, "y": p.y])
        if name == "touchDown" { self.startSampling() }
      }
      window.addGestureRecognizer(observer); self.observer = observer
      for name in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardDidShowNotification,
        UIResponder.keyboardWillHideNotification, UIResponder.keyboardDidHideNotification,
        UITextView.textDidBeginEditingNotification, UITextField.textDidBeginEditingNotification] {
        NotificationCenter.default.addObserver(self, selector: #selector(notification(_:)), name: name, object: nil)
      }
    }
    @objc private func notification(_ note: Notification) {
      events.append(["event": note.name.rawValue, "time": CACurrentMediaTime(),
        "duration": note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0])
    }
    private func startSampling() {
      generation += 1; let current = generation
      if link == nil {
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common); self.link = link
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
        guard let self, current == self.generation else { return }
        self.link?.invalidate(); self.link = nil
        let payload: [String: Any] = ["events": self.events, "frames": self.frames,
          "maximumFPS": self.window?.screen.maximumFramesPerSecond ?? 0]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        let url = URL.documentsDirectory.appendingPathComponent("composer-latency.json")
        DispatchQueue.global(qos: .utility).async { try? data.write(to: url, options: .atomic) }
      }
    }
    @objc private func frame(_ link: CADisplayLink) {
      let layer = layer.presentation() ?? layer
      let rect = layer.convert(layer.bounds, to: window?.layer)
      frames.append([CACurrentMediaTime(), link.timestamp, link.targetTimestamp, rect.minY, rect.height])
    }
    deinit {
      if let observer { observer.view?.removeGestureRecognizer(observer) }
      NotificationCenter.default.removeObserver(self)
    }
  }
}

struct ComposerLatencyControl: View {
  @State private var text = ""
  var body: some View {
    VStack {
      Button("Native text-field control") {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
      }.padding(.top, 80).accessibilityIdentifier("dismiss-control")
      Spacer()
      TextField("Message", text: $text, axis: .vertical)
        .padding(12).background(.gray.opacity(0.15), in: Capsule())
        .accessibilityIdentifier("message-input")
        .background(ComposerLatencyProbe())
    }.padding(30)
  }
}
#endif
