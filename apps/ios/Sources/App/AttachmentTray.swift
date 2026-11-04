import AVFoundation
import PhotosUI
import SwiftUI
import ThinkingOrbsKit
import UIKit
import UniformTypeIdentifiers

/// What the composer's + tray can do. Built fresh each time the tray opens.
struct AttachmentTrayActions {
  /// How many more attachments the draft can take.
  var remaining: Int
  /// Shown while drafting, when the mic has become Send.
  var voice: (() -> Void)?
  var photos: ([PHPickerResult]) -> Void
  var camera: (Data) -> Void
  var files: () -> Void
  var allPhotos: () -> Void
  /// Where added attachments land, in window coordinates.
  var composerFrame: () -> CGRect?
}

/// The + menu and the photo and camera panels it grows into. One card morphs
/// between them in a window above the chat, so presentations, the history and
/// the composer underneath stay untouched.
@MainActor final class AttachmentTray {
  static let shared = AttachmentTray()
  private var window: UIWindow?
  private weak var chatWindow: UIWindow?
  private var controller: AttachmentTrayController?

  func present(from button: UIView, actions: AttachmentTrayActions) {
    guard controller == nil, let scene = button.window?.windowScene else { return }
    warming?.isHidden = true
    warming = nil
    let window = UIWindow(windowScene: scene)
    window.windowLevel = .alert + 1
    window.backgroundColor = .clear
    window.overrideUserInterfaceStyle = button.traitCollection.userInterfaceStyle
    let controller = AttachmentTrayController(
      source: button.convert(button.bounds, to: nil), actions: actions
    ) { [weak self] in self?.dismissed() }
    window.rootViewController = controller
    // Not key while the menu shows: the composer's text field keeps first responder.
    window.isHidden = false
    self.window = window
    chatWindow = button.window
    self.controller = controller
    controller.open()
  }
  func close() { controller?.collapse() }

  /// The system photo picker runs in another process that takes seconds to start
  /// the first time (3 s on a simulator), then stays up for a while. Start it once
  /// with an invisible picker when a chat opens, so the tray's grid is ready on +.
  private var warming: UIWindow?
  private var warmed = false
  func prewarm(in scene: UIWindowScene) {
    guard !warmed, warming == nil, controller == nil else { return }
    warmed = true
    let window = UIWindow(windowScene: scene)
    // The picker only loads its grid while it is on screen; a nearly clear speck is.
    window.frame = CGRect(x: 0, y: scene.screen.bounds.height - 2, width: 2, height: 2)
    window.alpha = 0.011
    window.isUserInteractionEnabled = false
    window.windowLevel = .normal - 1
    let picker = PHPickerViewController(configuration: Self.pickerConfiguration(limit: 1))
    window.rootViewController = picker
    window.isHidden = false
    warming = window
    finishWarming(picker, deadline: .now() + 8)
  }
  private func finishWarming(_ picker: PHPickerViewController, deadline: DispatchTime) {
    guard let window = warming else { return }
    if picker.view.subviews.contains(where: { !$0.subviews.isEmpty }) || .now() > deadline || controller != nil {
      window.isHidden = true
      warming = nil
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
      self?.finishWarming(picker, deadline: deadline)
    }
  }

  static func pickerConfiguration(limit: Int) -> PHPickerConfiguration {
    var configuration = PHPickerConfiguration()
    configuration.filter = .any(of: [.images, .videos])
    configuration.selectionLimit = max(1, limit)
    configuration.selection = .continuous
    configuration.disabledCapabilities = [.search, .collectionNavigation, .selectionActions, .stagingArea]
    configuration.edgesWithoutContentMargins = .all
    return configuration
  }
  private func dismissed() {
    if window?.isKeyWindow == true { chatWindow?.makeKey() }
    window?.isHidden = true
    window = nil
    controller = nil
  }
}

private final class AttachmentTrayController: UIViewController, PHPickerViewControllerDelegate {
  private enum Stage { case menu, photos, camera }
  private let source: CGRect
  private let actions: AttachmentTrayActions
  private let finished: () -> Void
  private var stage = Stage.menu
  private var closing = false
  /// iOS draws the keyboard above every app window, so the panels can't cover it:
  /// the field typing went to gives it up as a panel opens, and takes it back if
  /// the panel is closed without adding anything.
  private weak var typing: UIResponder?

  private let backdrop = UIControl()
  private let card = UIView()
  /// Liquid Glass on iOS 26, as in the reference; a thick blur before it.
  private let material: UIVisualEffectView = {
    if #available(iOS 26, *) { return UIVisualEffectView(effect: UIGlassEffect(style: .regular)) }
    return UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
  }()
  private let menu = UIStackView()
  /// The photo or camera panel. It sits at its final place from the start and a
  /// mask grows it out of the menu with the card: the embedded picker ignores
  /// taps for a while after it moves on screen, so it must not travel with the card.
  private let panel = UIView()
  private let panelMask = UIView()
  private var picker: PHPickerViewController?
  /// Covers the picker's own "Loading…" until its grid arrives.
  private var pickerCover: UIView?
  private var camera: TrayCamera?
  private var selection: [PHPickerResult] = []
  private let back = TrayGlassButton(symbol: "chevron.left", label: "Back")
  private let add = TrayCapsuleButton()

  static let menuWidth: CGFloat = 278
  static let rowHeight: CGFloat = 68
  static let menuInset: CGFloat = 13
  static let menuRadius: CGFloat = 38
  static let panelRadius: CGFloat = 34
  static let panelInset: CGFloat = 12
  static let panelMaxWidth: CGFloat = 417
  static let control: CGFloat = 48
  static let controlInset: CGFloat = 22

  init(source: CGRect, actions: AttachmentTrayActions, finished: @escaping () -> Void) {
    self.source = source
    self.actions = actions
    self.finished = finished
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    backdrop.frame = view.bounds
    backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    backdrop.accessibilityLabel = "Close"
    backdrop.addAction(UIAction { [weak self] _ in self?.collapse() }, for: .touchUpInside)
    view.addSubview(backdrop)

    card.accessibilityIdentifier = "attachment-tray"
    material.frame = card.bounds
    material.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    material.layer.cornerCurve = .continuous
    // Glass draws its own shape and rim; clipping would cut the rim off.
    if #unavailable(iOS 26) { material.clipsToBounds = true }
    card.addSubview(material)
    view.addSubview(card)

    menu.axis = .vertical
    menu.accessibilityIdentifier = "attachment-menu-panel"
    let enabled = actions.remaining > 0
    addRow("Camera", symbol: "camera", identifier: "attach-camera", enabled: enabled) { [weak self] in
      self?.show(.camera)
    }
    addRow("Photos", symbol: "photo", identifier: "attach-photos", enabled: enabled) { [weak self] in
      self?.show(.photos)
    }
    addRow("Files", symbol: "paperclip", identifier: "attach-files", enabled: enabled) { [weak self] in
      guard let self else { return }
      self.collapse { self.actions.files() }
    }
    if let voice = actions.voice {
      addRow("Record voice note", symbol: "mic", identifier: "attach-voice", enabled: true) { [weak self] in
        self?.collapse(then: voice)
      }
    }
    material.contentView.addSubview(menu)

    // Barely visible rather than hidden: the embedded picker only loads its grid
    // while it is on screen, and it loads behind the menu.
    panel.alpha = 0.01
    panel.isUserInteractionEnabled = false
    panelMask.backgroundColor = .black
    panelMask.layer.cornerCurve = .continuous
    panel.mask = panelMask
    // Below the card until it opens: touches over the picker's grid go straight
    // to its process, past the app's hit-testing, and must not take the menu's.
    view.insertSubview(panel, belowSubview: card)
    // The embedded picker takes a moment to load its grid. Start it behind the
    // menu, so Photos opens on a full grid. It can't be warmed up any earlier:
    // a picker created before it, even one already removed, left it ignoring taps.
    if enabled { preparePicker() }
    back.accessibilityIdentifier = "attach-back"
    back.addAction(UIAction { [weak self] _ in self?.collapse() }, for: .touchUpInside)
    add.addAction(UIAction { [weak self] _ in self?.addSelection() }, for: .touchUpInside)
  }

  private func addRow(_ title: String, symbol: String, identifier: String, enabled: Bool,
    action: @escaping () -> Void) {
    let row = TrayMenuRow(title: title, symbol: symbol)
    row.accessibilityIdentifier = identifier
    row.isEnabled = enabled
    row.addAction(UIAction { _ in
      NativeHaptics.play(.selection, source: "composer.attach-option")
      action()
    }, for: .touchUpInside)
    menu.addArrangedSubview(row)
    row.heightAnchor.constraint(equalToConstant: Self.rowHeight).isActive = true
  }

  /// The card's corners. Glass takes them from its corner configuration, so its
  /// rim follows the shape as the menu grows into a panel.
  private func round(_ radius: CGFloat) {
    if #available(iOS 26, *) {
      material.cornerConfiguration = .corners(radius: .fixed(Double(radius)))
    } else {
      material.layer.cornerRadius = radius
    }
  }

  // MARK: Geometry

  private var anchor: CGPoint { CGPoint(x: source.midX, y: source.midY) }
  private var menuFrame: CGRect {
    let height = CGFloat(menu.arrangedSubviews.count) * Self.rowHeight + Self.menuInset * 2
    // The card's lower-leading corner sits just outside the + button, which it covers.
    let x = max(view.safeAreaInsets.left + 4, anchor.x - 31)
    let maxY = min(anchor.y + 31, view.bounds.height - 6)
    return CGRect(x: x, y: maxY - height, width: Self.menuWidth, height: height)
  }
  /// A 3:4 card, as wide as the phone allows and at most 417 points on a large
  /// display, centred on the chat column and 12 points above the bottom edge.
  private var panelFrame: CGRect {
    let bounds = view.bounds
    let inset = Self.panelInset
    // Clear of side regions such as the folded Duo's status strip.
    let leading = view.safeAreaInsets.left + inset
    let trailing = bounds.width - view.safeAreaInsets.right - inset
    let width = min(trailing - leading, Self.panelMaxWidth)
    let height = min((width * 4 / 3).rounded(), bounds.height - inset - view.safeAreaInsets.top - 60)
    let column = actions.composerFrame()?.midX ?? bounds.midX
    let x = min(max(leading, column - width / 2), trailing - width)
    return CGRect(x: x.rounded(), y: bounds.height - inset - height, width: width, height: height)
  }
  /// Collapsing into a point: the card's centre moves to `point` as it shrinks.
  private func collapsed(into point: CGPoint, scale: CGFloat) -> CGAffineTransform {
    let center = CGPoint(x: card.frame.midX, y: card.frame.midY)
    return CGAffineTransform(translationX: point.x - center.x, y: point.y - center.y)
      .scaledBy(x: scale, y: scale)
  }

  // MARK: Stages

  func open() {
    typing = UIResponder.current
    loadViewIfNeeded()
    view.layoutIfNeeded()
    panel.frame = panelFrame
    picker?.view.frame = panel.bounds
    card.transform = .identity
    // Under the menu card until a panel opens.
    panelMask.frame = menuFrame.offsetBy(dx: -panel.frame.minX, dy: -panel.frame.minY)
    card.frame = menuFrame
    round(Self.menuRadius)
    menu.frame = CGRect(x: 0, y: Self.menuInset, width: Self.menuWidth,
      height: card.bounds.height - Self.menuInset * 2)
    guard !UIAccessibility.isReduceMotionEnabled else { return }
    card.transform = collapsed(into: anchor, scale: 0.16)
    card.alpha = 0
    let spring = UIViewPropertyAnimator(duration: 0.42, dampingRatio: 0.78) {
      self.card.transform = .identity
    }
    spring.startAnimation()
    UIView.animate(withDuration: 0.12) { self.card.alpha = 1 }
  }

  private func show(_ next: Stage) {
    guard stage == .menu, !closing else { return }
    stage = next
    let target = panelFrame
    panel.transform = .identity
    panel.frame = target
    let content = panel.bounds
    // Start the reveal at the menu card's shape.
    panelMask.frame = card.frame.offsetBy(dx: -target.minX, dy: -target.minY)
    panelMask.layer.cornerRadius = Self.menuRadius
    switch next {
    case .photos: buildPhotos(in: content)
    case .camera: buildCamera(in: content)
    case .menu: break
    }
    backdrop.isEnabled = false
    view.bringSubviewToFront(panel)
    panel.isUserInteractionEnabled = true
    typing?.resignFirstResponder()
    // The embedded picker only takes touches in the key window.
    view.window?.makeKey()
    let reduce = UIAccessibility.isReduceMotionEnabled
    let grow = UIViewPropertyAnimator(duration: reduce ? 0.2 : 0.46, dampingRatio: 0.86) {
      self.card.frame = target
      self.round(Self.panelRadius)
      self.panelMask.frame = content
      self.panelMask.layer.cornerRadius = Self.panelRadius
    }
    grow.startAnimation()
    UIView.animate(withDuration: 0.12, delay: 0, options: [.curveEaseOut]) { self.menu.alpha = 0 }
    UIView.animate(withDuration: 0.26, delay: reduce ? 0 : 0.1, options: [.curveEaseOut]) {
      self.panel.alpha = 1
    }
  }

  /// Back, outside taps, Files and All Photos: shrink into the + button.
  func collapse(then action: (() -> Void)? = nil) {
    guard !closing else { return }
    closing = true
    view.isUserInteractionEnabled = false
    camera?.stop()
    if stage != .menu && action == nil, let typing {
      // The tray became key for the picker; typing resumes in the chat's window.
      (typing as? UIView)?.window?.makeKey()
      typing.becomeFirstResponder()
    }
    let target = collapsed(into: anchor, scale: 0.14)
    guard !UIAccessibility.isReduceMotionEnabled else { finish(action); return }
    // At the panel stage the panel and the card share a frame, so one transform moves both.
    let shrink = UIViewPropertyAnimator(duration: 0.34, dampingRatio: 1) {
      self.card.transform = target
      if self.stage != .menu { self.panel.transform = target }
    }
    shrink.startAnimation()
    UIView.animate(withDuration: 0.2, delay: 0.1, options: [.curveEaseIn]) {
      self.card.alpha = 0
      self.panel.alpha = 0
    }
    shrink.addCompletion { _ in self.finish(action) }
    // Presentations wait for the tray's window to leave.
  }

  /// Add and the shutter: settle into the composer, where the new attachments appear.
  private func settle(then action: @escaping () -> Void) {
    guard !closing else { return }
    closing = true
    view.isUserInteractionEnabled = false
    camera?.stop()
    action()
    let frame = actions.composerFrame() ?? source
    guard !UIAccessibility.isReduceMotionEnabled else { finish(nil); return }
    let radius = min(frame.height / 2, 28)
    let shrink = UIViewPropertyAnimator(duration: 0.32, dampingRatio: 1) {
      self.card.frame = frame
      self.round(radius)
      self.panelMask.frame = frame.offsetBy(dx: -self.panel.frame.minX, dy: -self.panel.frame.minY)
      self.panelMask.layer.cornerRadius = radius
      self.panel.alpha = 0
    }
    shrink.startAnimation()
    UIView.animate(withDuration: 0.18, delay: 0.1, options: [.curveEaseIn]) { self.card.alpha = 0 }
    shrink.addCompletion { _ in self.finish(nil) }
  }

  private func removePicker() {
    picker?.willMove(toParent: nil)
    picker?.view.removeFromSuperview()
    picker?.removeFromParent()
    picker = nil
  }

  private func finish(_ action: (() -> Void)?) {
    removePicker()
    finished()
    action?()
  }

  // MARK: Photos

  private func preparePicker() {
    let picker = PHPickerViewController(
      configuration: AttachmentTray.pickerConfiguration(limit: actions.remaining))
    picker.delegate = self
    addChild(picker)
    panel.addSubview(picker.view)
    picker.didMove(toParent: self)
    self.picker = picker
  }

  private func buildPhotos(in bounds: CGRect) {
    if picker == nil { preparePicker() }
    picker?.view.frame = bounds
    coverPicker(in: bounds)
    place(back, at: CGPoint(x: Self.controlInset, y: bounds.height - Self.controlInset - Self.control))
    panel.addSubview(back)
    panel.addSubview(add)
    updateAdd(animated: false)
  }

  /// The picker draws a system spinner and "Loading…" until its out-of-process grid
  /// attaches, which takes a couple of seconds on a cold start. Show the app's
  /// connecting orb over it instead, and fade it out once the grid's host view lands.
  private func coverPicker(in bounds: CGRect) {
    guard let picker, !pickerLoaded(picker) else { return }
    let cover = UIView(frame: bounds)
    cover.backgroundColor = .systemBackground
    cover.isUserInteractionEnabled = false
    let orb = UIHostingController(rootView: ThinkingOrb(state: .connecting, size: .px64)
      .accessibilityLabel("Loading photos"))
    orb.view.backgroundColor = .clear
    orb.view.frame = CGRect(x: 0, y: 0, width: 64, height: 64)
    orb.view.center = CGPoint(x: bounds.midX, y: bounds.midY)
    cover.addSubview(orb.view)
    panel.insertSubview(cover, aboveSubview: picker.view)
    pickerCover = cover
    revealWhenLoaded(cover)
  }

  private func revealWhenLoaded(_ cover: UIView) {
    guard let picker, pickerCover === cover else { return }
    guard pickerLoaded(picker) else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.revealWhenLoaded(cover) }
      return
    }
    pickerCover = nil
    UIView.animate(withDuration: 0.2, delay: 0.08, options: [.curveEaseOut],
      animations: { cover.alpha = 0 }, completion: { _ in cover.removeFromSuperview() })
  }

  /// The grid lives in another process; it is ready once its host view is in the picker's tree.
  private func pickerLoaded(_ picker: PHPickerViewController) -> Bool {
    picker.view.subviews.contains { !$0.subviews.isEmpty }
  }

  private func updateAdd(animated: Bool) {
    let count = selection.count
    let videos = selection.filter(\.isVideo).count
    let noun = videos == 0 ? "photo" : videos == count ? "video" : "item"
    let title = count == 0 ? "All Photos" : "Add \(count) \(noun)" + (count == 1 ? "" : "s")
    let change = {
      self.add.set(title: title)
      let width = self.add.fittingWidth
      self.add.frame = CGRect(x: self.panel.bounds.width - Self.controlInset - width,
        y: self.panel.bounds.height - Self.controlInset - Self.control, width: width, height: Self.control)
    }
    guard animated, !UIAccessibility.isReduceMotionEnabled else { change(); return }
    UIViewPropertyAnimator(duration: 0.3, dampingRatio: 0.82, animations: change).startAnimation()
  }

  private func addSelection() {
    if selection.isEmpty {
      collapse { self.actions.allPhotos() }
      return
    }
    NativeHaptics.play(.light, source: "composer.attach")
    let picked = selection
    settle { self.actions.photos(picked) }
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    let grew = results.count > selection.count
    selection = results
    if grew { NativeHaptics.play(.selection, source: "composer.attach-option") }
    updateAdd(animated: true)
  }

  // MARK: Camera

  private func buildCamera(in bounds: CGRect) {
    removePicker()
    let camera = TrayCamera(frame: bounds)
    camera.back.accessibilityIdentifier = "attach-back"
    camera.back.addAction(UIAction { [weak self] _ in self?.collapse() }, for: .touchUpInside)
    camera.captured = { [weak self] data in
      guard let self else { return }
      NativeHaptics.play(.light, source: "composer.attach")
      self.settle { self.actions.camera(data) }
    }
    panel.addSubview(camera)
    self.camera = camera
    camera.start()
  }

  private func place(_ button: UIView, at origin: CGPoint) {
    button.frame = CGRect(origin: origin, size: CGSize(width: Self.control, height: Self.control))
  }

  override func accessibilityPerformEscape() -> Bool { collapse(); return true }
}

// MARK: - Controls

private final class TrayMenuRow: UIControl {
  private let circle = UIView()
  private let icon = UIImageView()
  private let label = UILabel()
  private let highlight = UIView()
  init(title: String, symbol: String) {
    super.init(frame: .zero)
    highlight.backgroundColor = UIColor.label.withAlphaComponent(0.06)
    highlight.alpha = 0
    highlight.isUserInteractionEnabled = false
    addSubview(highlight)
    circle.backgroundColor = UIColor.label.withAlphaComponent(0.07)
    circle.layer.cornerRadius = 22
    circle.isUserInteractionEnabled = false
    addSubview(circle)
    icon.image = UIImage(systemName: symbol,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular))
    icon.tintColor = .label
    icon.contentMode = .center
    circle.addSubview(icon)
    label.text = title
    label.font = .systemFont(ofSize: 20)
    label.textColor = .label
    addSubview(label)
    isAccessibilityElement = true
    accessibilityLabel = title
    accessibilityTraits = .button
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layoutSubviews() {
    super.layoutSubviews()
    highlight.frame = bounds
    circle.frame = CGRect(x: 22, y: (bounds.height - 44) / 2, width: 44, height: 44)
    icon.frame = circle.bounds
    label.frame = CGRect(x: 84, y: 0, width: bounds.width - 100, height: bounds.height)
  }
  override var isHighlighted: Bool {
    didSet { UIView.animate(withDuration: 0.12) { self.highlight.alpha = self.isHighlighted ? 1 : 0 } }
  }
  override var isEnabled: Bool {
    didSet {
      alpha = isEnabled ? 1 : 0.4
      accessibilityTraits = isEnabled ? .button : [.button, .notEnabled]
    }
  }
}

/// A 48-point circular glass control, as on the reference's panels. Over the
/// camera it is always dark; over the photo grid it follows the appearance.
extension UIButton.Configuration {
  /// Clear Liquid Glass with a light wash of the background colour, so the
  /// photos or camera show through. The system picks the label colour from
  /// what is behind the glass, so it stays readable over light and dark photos.
  static func trayGlass() -> UIButton.Configuration {
    let wash = UIColor { $0.userInterfaceStyle == .dark
      ? UIColor.black.withAlphaComponent(0.42) : UIColor.white.withAlphaComponent(0.55) }
    if #available(iOS 26, *) {
      var configuration = UIButton.Configuration.clearGlass()
      configuration.background.backgroundColor = wash
      return configuration
    }
    var configuration = UIButton.Configuration.filled()
    configuration.baseBackgroundColor = .secondarySystemBackground
    configuration.baseForegroundColor = .label
    return configuration
  }
}

private final class TrayGlassButton: UIButton {
  init(symbol: String, label: String, dark: Bool = false) {
    super.init(frame: .zero)
    var configuration = UIButton.Configuration.trayGlass()
    configuration.image = UIImage(systemName: symbol,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
    configuration.cornerStyle = .capsule
    self.configuration = configuration
    if dark { overrideUserInterfaceStyle = .dark }
    accessibilityLabel = label
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

/// "All Photos", or "Add N photos" once something is selected, on the same clear glass.
private final class TrayCapsuleButton: UIButton {
  private var title = ""
  init() {
    super.init(frame: .zero)
    accessibilityIdentifier = "attach-add-photos"
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func set(title: String) {
    self.title = title
    var configuration = UIButton.Configuration.trayGlass()
    configuration.cornerStyle = .capsule
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18)
    var text = AttributedString(title)
    text.font = .systemFont(ofSize: 17, weight: .semibold)
    configuration.attributedTitle = text
    self.configuration = configuration
    accessibilityLabel = title
  }
  var fittingWidth: CGFloat {
    let width = (title as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: 17, weight: .semibold)]).width
    return ceil(width) + 36
  }
}

// MARK: - Camera

/// A live camera filling the panel: back, shutter, and more (flash, flip).
private final class TrayCamera: UIView, AVCapturePhotoCaptureDelegate {
  let back = TrayGlassButton(symbol: "chevron.left", label: "Back", dark: true)
  private let more = TrayGlassButton(symbol: "ellipsis", label: "More camera controls", dark: true)
  private let flash = UIButton(type: .system)
  private let flip = UIButton(type: .system)
  private let shutter = UIButton(type: .custom)
  private let preview = UIView()
  private let still = UIImageView()
  private let message = UILabel()
  private let session = AVCaptureSession()
  private let output = AVCapturePhotoOutput()
  private let queue = DispatchQueue(label: "attachment-tray.camera")
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var position = AVCaptureDevice.Position.back
  private var flashMode = AVCaptureDevice.FlashMode.off
  private var expanded = false
  private var capturing = false
  var captured: ((Data) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    preview.frame = bounds
    preview.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(preview)
    still.frame = bounds
    still.contentMode = .scaleAspectFill
    still.clipsToBounds = true
    still.isHidden = true
    addSubview(still)
    message.textColor = UIColor(white: 1, alpha: 0.7)
    message.font = .systemFont(ofSize: 15)
    message.textAlignment = .center
    message.numberOfLines = 0
    message.frame = bounds.insetBy(dx: 32, dy: 0)
    addSubview(message)

    let control = AttachmentTrayController.control
    let inset = AttachmentTrayController.controlInset
    let bottom = bounds.height - inset - control
    back.frame = CGRect(x: inset, y: bottom, width: control, height: control)
    addSubview(back)
    more.frame = CGRect(x: bounds.width - inset - control, y: bottom, width: control, height: control)
    more.addAction(UIAction { [weak self] _ in self?.toggleMore() }, for: .touchUpInside)
    addSubview(more)

    let shutterSize: CGFloat = 60
    shutter.frame = CGRect(x: (bounds.width - shutterSize) / 2, y: bottom + (control - shutterSize) / 2,
      width: shutterSize, height: shutterSize)
    shutter.backgroundColor = .white
    shutter.layer.cornerRadius = shutterSize / 2
    shutter.accessibilityLabel = "Take photo"
    shutter.accessibilityIdentifier = "attach-shutter"
    shutter.addAction(UIAction { [weak self] _ in self?.capture() }, for: .touchUpInside)
    shutter.addAction(UIAction { [weak self] _ in
      UIView.animate(withDuration: 0.12) { self?.shutter.transform = CGAffineTransform(scaleX: 0.88, y: 0.88) }
    }, for: .touchDown)
    shutter.addAction(UIAction { [weak self] _ in
      UIView.animate(withDuration: 0.2) { self?.shutter.transform = .identity }
    }, for: [.touchUpOutside, .touchCancel])
    addSubview(shutter)

    for (button, symbol, label) in [(flash, "bolt.slash", "Flash"), (flip, "arrow.triangle.2.circlepath", "Switch camera")] {
      button.setImage(UIImage(systemName: symbol,
        withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .medium)), for: .normal)
      button.tintColor = .white
      button.accessibilityLabel = label
      button.frame = more.frame
      button.alpha = 0
      button.isUserInteractionEnabled = false
      insertSubview(button, belowSubview: more)
    }
    flash.addAction(UIAction { [weak self] _ in self?.toggleFlash() }, for: .touchUpInside)
    flip.addAction(UIAction { [weak self] _ in self?.switchCamera() }, for: .touchUpInside)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func start() {
    #if DEBUG
    if let path = UserDefaults.standard.string(forKey: "ui-testing-camera-fixture"),
      AVCaptureDevice.default(for: .video) == nil, let image = UIImage(contentsOfFile: path) {
      still.image = image
      still.isHidden = false
      return
    }
    #endif
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: configure()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        Task { @MainActor in granted ? self.configure() : self.show("Allow camera access in Settings to take a photo.") }
      }
    default: show("Allow camera access in Settings to take a photo.")
    }
  }
  func stop() {
    let session = session
    queue.async { if session.isRunning { session.stopRunning() } }
  }
  private func show(_ text: String) {
    message.text = text
    shutter.isEnabled = false
    shutter.alpha = 0.4
  }
  private func configure() {
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
      let input = try? AVCaptureDeviceInput(device: device) else {
      show("The camera isn't available.")
      return
    }
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    layer.frame = preview.bounds
    preview.layer.addSublayer(layer)
    previewLayer = layer
    preview.alpha = 0
    let session = session, output = output
    queue.async {
      session.beginConfiguration()
      session.sessionPreset = .photo
      if session.canAddInput(input) { session.addInput(input) }
      if session.canAddOutput(output) { session.addOutput(output) }
      session.commitConfiguration()
      session.startRunning()
      DispatchQueue.main.async {
        UIView.animate(withDuration: 0.25) { self.preview.alpha = 1 }
      }
    }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer?.frame = preview.bounds
  }

  private func toggleMore() {
    expanded.toggle()
    var configuration = more.configuration
    configuration?.image = UIImage(systemName: expanded ? "xmark" : "ellipsis",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
    more.configuration = configuration
    more.accessibilityLabel = expanded ? "Hide camera controls" : "More camera controls"
    let spacing: CGFloat = 58
    let animations = {
      for (index, button) in [self.flip, self.flash].enumerated() {
        button.frame = self.more.frame.offsetBy(dx: 0, dy: self.expanded ? -spacing * CGFloat(index + 1) : 0)
        button.alpha = self.expanded ? 1 : 0
        button.isUserInteractionEnabled = self.expanded
      }
    }
    UIViewPropertyAnimator(duration: 0.38, dampingRatio: 0.8, animations: animations).startAnimation()
  }
  private func toggleFlash() {
    flashMode = flashMode == .off ? .on : .off
    flash.setImage(UIImage(systemName: flashMode == .on ? "bolt.fill" : "bolt.slash",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .medium)), for: .normal)
    flash.accessibilityValue = flashMode == .on ? "On" : "Off"
  }
  private func switchCamera() {
    let next: AVCaptureDevice.Position = position == .back ? .front : .back
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: next),
      let input = try? AVCaptureDeviceInput(device: device) else { return }
    position = next
    let session = session
    UIView.transition(with: preview, duration: 0.3, options: [.transitionFlipFromLeft]) {}
    queue.async {
      session.beginConfiguration()
      session.inputs.forEach { session.removeInput($0) }
      if session.canAddInput(input) { session.addInput(input) }
      session.commitConfiguration()
    }
  }

  private func capture() {
    UIView.animate(withDuration: 0.2) { self.shutter.transform = .identity }
    guard !capturing else { return }
    capturing = true
    let blink = UIView(frame: bounds)
    blink.backgroundColor = .black
    blink.alpha = 0
    insertSubview(blink, belowSubview: back)
    UIView.animate(withDuration: 0.08, animations: { blink.alpha = 1 }) { _ in
      UIView.animate(withDuration: 0.2, animations: { blink.alpha = 0 }) { _ in blink.removeFromSuperview() }
    }
    if !still.isHidden, let image = still.image, let data = image.jpegData(compressionQuality: 0.9) {
      captured?(data)
      return
    }
    let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
    if output.supportedFlashModes.contains(flashMode) { settings.flashMode = flashMode }
    output.capturePhoto(with: settings, delegate: self)
  }
  nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto,
    error: Error?) {
    let data = photo.fileDataRepresentation()
    Task { @MainActor in
      self.capturing = false
      if let data { self.captured?(data) }
    }
  }
}

/// A picked photo or video, copied out of the library.
enum PickedMedia {
  case data(Data, UTType)
  case file(URL, UTType)
}

extension PHPickerResult {
  var isVideo: Bool { itemProvider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) }

  /// Loads the original bytes, reporting the system's copy progress (an iCloud
  /// download, or a large video) as it goes. Videos arrive as a file we own.
  @MainActor func load(progress: @escaping (Double) -> Void) async throws -> PickedMedia {
    let provider = itemProvider
    let video = isVideo
    let type = provider.registeredTypeIdentifiers.compactMap(UTType.init)
      .first { $0.conforms(to: video ? .movie : .image) } ?? (video ? .quickTimeMovie : .jpeg)
    var loading: Progress?
    let poll = Task { @MainActor in
      while !Task.isCancelled {
        if let loading { progress(loading.fractionCompleted) }
        try? await Task.sleep(for: .milliseconds(50))
      }
    }
    defer { poll.cancel() }
    let media: PickedMedia = try await withCheckedThrowingContinuation { continuation in
      if video {
        loading = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
          // The provider deletes its copy when this returns.
          guard let url else {
            continuation.resume(throwing: error ?? APIError("This video could not be loaded."))
            return
          }
          let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
          let copy = folder.appendingPathComponent(url.lastPathComponent)
          do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: url, to: copy)
            continuation.resume(returning: .file(copy, type))
          } catch { continuation.resume(throwing: error) }
        }
      } else {
        loading = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, error in
          if let data { continuation.resume(returning: .data(data, type)) }
          else { continuation.resume(throwing: error ?? APIError("This photo could not be loaded.")) }
        }
      }
    }
    progress(1)
    return media
  }
}

private extension UIResponder {
  private static weak var found: UIResponder?
  /// The first responder, found by sending it an action.
  static var current: UIResponder? {
    found = nil
    UIApplication.shared.sendAction(#selector(record), to: nil, from: nil, for: nil)
    return found
  }
  @objc private func record() { UIResponder.found = self }
}
