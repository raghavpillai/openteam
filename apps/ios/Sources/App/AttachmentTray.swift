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
  var photos: ([PHPickerResult]) -> Void
  var camera: (Data) -> Void
  var files: () -> Void
  /// Where added attachments land, in window coordinates.
  var composerFrame: () -> CGRect?
  /// The chat column's edge, including a sidebar or the Duo's fold division.
  var contentLeading: () -> CGFloat = { 0 }
  /// Keeps the composer's own focus state in step when the tray moves the
  /// keyboard, so SwiftUI doesn't later restore a focus it still believes in.
  var focus: (Bool) -> Void = { _ in }
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
      source: button, actions: actions
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
  func layoutChanged() {
    if let window, let chatWindow, window.bounds.size != chatWindow.bounds.size {
      window.frame = chatWindow.frame
    }
    controller?.viewIfLoaded?.setNeedsLayout()
  }
  func update(from button: UIView, actions: AttachmentTrayActions) {
    controller?.update(from: button, actions: actions)
  }

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
  private weak var sourceButton: UIView?
  private var source: CGRect
  private var viewport: CGRect = .zero
  private var safeInsets = UIEdgeInsets.zero
  private var columnLeading: CGFloat = 0
  private var actions: AttachmentTrayActions
  private let finished: () -> Void
  private var stage = Stage.menu
  private var closing = false
  private var transition: UIViewPropertyAnimator?
  /// iOS draws the keyboard above every app window, so the panels can't cover
  /// it, and the embedded picker needs this window to be key, which takes the
  /// keyboard from the field anyway. The menu opens above the live keyboard. As
  /// a panel opens, the field gives the keyboard up at once beneath a still of
  /// the chat, so neither the transcript nor the composer moves under the tray;
  /// the keyboard rises back into the still's gap on Back or when the tray closes.
  private weak var typing: UIResponder?
  private var still: UIView?
  /// The composer as the still shows it, where added attachments settle.
  private var heldComposer: CGRect?

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
  private let morphBlur = UIVisualEffectView()
  private var morphSnapshot: UIView?
  private var picker: PHPickerViewController?
  /// Covers the picker's own "Loading…" until its grid arrives.
  private var pickerCover: UIView?
  private var camera: TrayCamera?
  private var selection: [PHPickerResult] = []
  private let back = TrayGlassButton(symbol: "chevron.left", label: "Back")
  private let add = TrayCapsuleButton()

  static let menuWidth: CGFloat = 278
  // Measured from the reference at 3x: rows 206 px apart, 33 px above and below.
  static let rowHeight: CGFloat = 206 / 3
  static let menuInset: CGFloat = 11
  static let menuRadius: CGFloat = 38
  static let panelRadius: CGFloat = 24
  static let panelInset: CGFloat = 12
  static let panelMaxWidth: CGFloat = 370
  static let control: CGFloat = 44
  static let controlInset: CGFloat = 24

  init(source: UIView, actions: AttachmentTrayActions, finished: @escaping () -> Void) {
    sourceButton = source
    self.source = source.convert(source.bounds, to: nil)
    self.actions = actions
    self.finished = finished
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardDidShow),
      name: UIResponder.keyboardDidShowNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillHide),
      name: UIResponder.keyboardWillHideNotification, object: nil)
    backdrop.frame = view.bounds
    backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    backdrop.accessibilityLabel = "Close"
    backdrop.accessibilityIdentifier = "attachment-tray-dismiss"
    backdrop.isAccessibilityElement = true
    backdrop.accessibilityTraits = .button
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
    back.addAction(UIAction { [weak self] _ in self?.returnToMenu() }, for: .touchUpInside)
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
  /// The card's glass, present or not. Inside an animation, iOS 26 materializes
  /// or dissolves Liquid Glass itself (refraction, rim and highlight together)
  /// instead of fading a flattened layer; earlier systems fade the blur.
  private func setGlass(_ visible: Bool) {
    if #available(iOS 26, *) {
      material.effect = visible ? UIGlassEffect(style: .regular) : nil
    } else {
      card.alpha = visible ? 1 : 0
    }
  }

  private var menuFade: UIViewPropertyAnimator?
  private var menuFadeID = 0
  private func cancelMenuFade() {
    menuFade?.stopAnimation(true)
    menuFade = nil
    menuFadeID += 1
  }
  private func fadeMenu(in visible: Bool) {
    menuFade?.stopAnimation(true)
    menuFade = nil
    menuFadeID += 1
    let id = menuFadeID
    let start = { [weak self] in
      guard let self, self.menuFadeID == id else { return }
      let fade = UIViewPropertyAnimator(duration: visible ? 0.16 : 0.08,
        curve: visible ? .easeOut : .linear) { self.menu.alpha = visible ? 1 : 0 }
      self.menuFade = fade
      fade.startAnimation()
    }
    // Liquid Glass takes about 130 ms to materialize; the rows come in as it
    // finishes, and leave before it starts to dissolve. The wait is not an
    // animator delay: one shows the final opacity until it begins.
    if visible { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: start) } else { start() }
  }

  private func round(_ radius: CGFloat) {
    if #available(iOS 26, *) {
      material.cornerConfiguration = .corners(radius: .fixed(Double(radius)))
    } else {
      material.layer.cornerRadius = radius
    }
  }

  // MARK: Geometry

  func update(from button: UIView, actions: AttachmentTrayActions) {
    guard sourceButton === button else { return }
    self.actions = actions
    viewIfLoaded?.setNeedsLayout()
  }

  override func viewWillTransition(to size: CGSize, with coordinator: any UIViewControllerTransitionCoordinator) {
    super.viewWillTransition(to: size, with: coordinator)
    coordinator.animate(alongsideTransition: nil) { [weak self] _ in
      self?.view.setNeedsLayout()
      self?.view.layoutIfNeeded()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    guard !closing, let button = sourceButton, button.window != nil else { return }
    let current = button.convert(button.bounds, to: view)
    let resized = viewport != view.bounds || safeInsets != view.safeAreaInsets
    let movedColumn = abs(current.minX - source.minX) > 0.5 || current.width != source.width
      || columnLeading != actions.contentLeading()
    guard resized || movedColumn else { return }
    if resized && still != nil {
      // A fold or rotation reflows the chat; the still no longer matches it.
      releaseStill(typing: true) {}
      heldComposer = nil
    }
    viewport = view.bounds
    safeInsets = view.safeAreaInsets
    columnLeading = actions.contentLeading()
    // Folding, rotating, and resizing the sidebar all move the composer. Keep
    // its original keyboard height during a panel's round trip, but refresh it
    // when the actual display changes.
    source = CGRect(x: current.minX, y: resized ? current.minY : source.minY,
      width: current.width, height: current.height)
    if let transition {
      transition.stopAnimation(false)
      transition.finishAnimation(at: .end)
    }
    card.transform = .identity
    panel.transform = .identity
    panel.frame = panelFrame
    picker?.view.frame = panel.bounds
    pickerCover?.frame = panel.bounds
    if let orb = pickerCover?.subviews.first { orb.center = CGPoint(x: panel.bounds.midX, y: panel.bounds.midY) }
    camera?.frame = panel.bounds
    if stage == .menu {
      card.frame = menuFrame
      panelMask.frame = menuFrame.offsetBy(dx: -panel.frame.minX, dy: -panel.frame.minY)
    } else {
      card.frame = panel.frame
      panelMask.frame = panel.bounds
      if stage == .photos {
        place(back, at: CGPoint(x: Self.controlInset, y: panel.bounds.height - Self.controlInset - Self.control))
        updateAdd(animated: false)
      }
    }
  }

  private var anchor: CGPoint { CGPoint(x: source.midX, y: source.midY) }
  private var menuFrame: CGRect {
    let height = CGFloat(menu.arrangedSubviews.count) * Self.rowHeight + Self.menuInset * 2
    // The card's lower-leading corner sits just outside the + button, which it covers.
    let x = min(max(view.safeAreaInsets.left + 4, actions.contentLeading() + 4, anchor.x - 31),
      view.bounds.width - view.safeAreaInsets.right - Self.menuWidth - 4)
    // Above a keyboard, which stays live and visible beneath the menu.
    let maxY = min(anchor.y + 31, view.bounds.height - 6)
    return CGRect(x: x, y: maxY - height, width: Self.menuWidth, height: height)
  }
  /// Both panels sit 12 points from the column's edges, as in the reference, and
  /// keep its 370-point width and 4:3 shape on wider screens.
  private var panelFrame: CGRect {
    let bounds = view.bounds
    let inset = Self.panelInset
    // Clear of side regions such as the folded Duo's status strip.
    let leading = max(view.safeAreaInsets.left, actions.contentLeading()) + inset
    // A side inset (the folded Duo's status strip) already clears the edge, so
    // the panel meets it, as the reference's 370-point panel does there.
    let trailing = bounds.width - max(view.safeAreaInsets.right, inset)
    let width = min(trailing - leading, Self.panelMaxWidth)
    let height = min((width * 4 / 3).rounded(), bounds.height - inset - view.safeAreaInsets.top - 60)
    // Centred in the column when it is wider than the panel.
    let x = leading + (trailing - leading - width) / 2
    return CGRect(x: x.rounded(), y: bounds.height - inset - height, width: width, height: height)
  }
  /// Collapsing into a point: the card's centre moves to `point` as it shrinks.
  private func collapsed(_ surface: UIView, into point: CGPoint, scale: CGFloat) -> CGAffineTransform {
    let center = CGPoint(x: surface.frame.midX, y: surface.frame.midY)
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
    card.transform = collapsed(card, into: anchor, scale: 0.16)
    setGlass(false)
    menu.alpha = 0
    menu.isUserInteractionEnabled = false
    animate(Motion.menuOpen, animations: {
      self.card.transform = .identity
      // Liquid Glass materializes natively as the menu springs out of +.
      self.setGlass(true)
    }, completion: { self.menu.isUserInteractionEnabled = true })
    // The rows follow the glass rather than leading it, so no label is ever
    // drawn over the chat before there is glass behind it.
    fadeMenu(in: true)
  }

  private func show(_ next: Stage) {
    guard stage == .menu, !closing, transition == nil else { return }
    cancelMenuFade()
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
    menu.accessibilityElementsHidden = true
    view.bringSubviewToFront(panel)
    panel.isUserInteractionEnabled = false
    prepareMorph(from: card, radius: Self.menuRadius)
    if morphSnapshot != nil { menu.alpha = 0 }
    freezeChat()
    // The embedded picker only takes touches in the key window.
    view.window?.makeKey()
    animate(Motion.morph, animations: {
      self.card.frame = target
      self.round(Self.panelRadius)
      self.morphSnapshot?.frame = target
      self.morphSnapshot?.layer.cornerRadius = Self.panelRadius
      self.morphSnapshot?.alpha = 0
      self.morphBlur.effect = UIBlurEffect(style: .systemUltraThinMaterial)
      self.panelMask.frame = content
      self.panelMask.layer.cornerRadius = Self.panelRadius
      self.menu.alpha = 0
      self.panel.alpha = 1
    }, completion: {
      self.clearMorph()
      self.panel.isUserInteractionEnabled = true
    })
  }

  /// Back retraces the expansion and preserves the photo selection and grid.
  private func returnToMenu() {
    guard stage != .menu, !closing, transition == nil else { return }
    cancelMenuFade()
    prepareMorph(from: panel, radius: Self.panelRadius)
    stage = .menu
    camera?.stop()
    panel.isUserInteractionEnabled = false
    menu.isUserInteractionEnabled = false
    menu.accessibilityElementsHidden = false
    if morphSnapshot != nil { panel.alpha = 0 }
    // The keyboard rises back into the gap the still keeps for it as the panel
    // folds into the menu, so the menu returns above a live keyboard.
    releaseStill(typing: true) {}
    let target = menuFrame
    animate(Motion.morph, animations: {
      self.card.frame = target
      self.round(Self.menuRadius)
      self.morphSnapshot?.frame = target
      self.morphSnapshot?.layer.cornerRadius = Self.menuRadius
      self.morphSnapshot?.alpha = 0
      self.morphBlur.effect = UIBlurEffect(style: .systemUltraThinMaterial)
      self.panelMask.frame = target.offsetBy(dx: -self.panel.frame.minX, dy: -self.panel.frame.minY)
      self.panelMask.layer.cornerRadius = Self.menuRadius
      self.panel.alpha = 0
      self.menu.alpha = 1
    }, completion: {
      self.camera?.removeFromSuperview()
      self.camera = nil
      self.picker?.view.isHidden = true
      self.pickerCover?.removeFromSuperview()
      self.pickerCover = nil
      self.clearMorph()
      self.view.insertSubview(self.panel, belowSubview: self.card)
      self.menu.isUserInteractionEnabled = true
      UIAccessibility.post(notification: .screenChanged, argument: self.menu.arrangedSubviews.first)
    })
  }

  // MARK: Keyboard


  private func freezeChat() {
    // The chat's own window, without this tray's menu above it (or the
    // keyboard, which iOS composites outside the app).
    guard still == nil, let typing, typing.isFirstResponder, let chat = sourceButton?.window,
      let still = chat.snapshotView(afterScreenUpdates: false) else { return }
    still.frame = view.convert(chat.bounds, from: chat)
    still.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    still.isUserInteractionEnabled = false
    still.accessibilityElementsHidden = true
    view.insertSubview(still, at: 0)
    self.still = still
    heldComposer = actions.composerFrame()
    UIView.performWithoutAnimation { _ = typing.resignFirstResponder() }
    actions.focus(false)
  }

  /// Typing resumes in the chat's window. The keyboard rises into the gap the
  /// still keeps for it, so the chat beneath never moves.
  private func restoreTyping() {
    guard let typing else { return }
    (typing as? UIView)?.window?.makeKey()
    guard !typing.isFirstResponder else { return }
    _ = typing.becomeFirstResponder()
    actions.focus(true)
  }

  /// Leave the still once the live chat underneath matches it again: with the
  /// keyboard back, or (when typing doesn't resume) fading to the settled chat.
  private func releaseStill(typing resumes: Bool, then done: @escaping () -> Void) {
    guard let still else { done(); return }
    self.still = nil
    if resumes { restoreTyping() }
    let fade = {
      UIView.animate(withDuration: resumes ? 0.12 : 0.22, delay: 0, options: [.curveEaseOut],
        animations: { still.alpha = 0 }, completion: { _ in still.removeFromSuperview(); done() })
    }
    guard resumes, !keyboardShown else { fade(); return }
    pendingRelease = fade
    // A hardware keyboard never shows one; nor does a field that declined focus.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.runPendingRelease() }
  }
  private var pendingRelease: (() -> Void)?
  /// Whether a keyboard has finished appearing and not started to leave.
  private var keyboardShown = false
  @objc private func keyboardDidShow() {
    keyboardShown = true
    runPendingRelease()
  }
  @objc private func keyboardWillHide() { keyboardShown = false }
  private func runPendingRelease() {
    let release = pendingRelease
    pendingRelease = nil
    release?()
  }

  /// Stretch the outgoing contents with the glass outline. The live picker stays
  /// at its settled frame so its remote touch coordinates remain valid.
  private func prepareMorph(from surface: UIView, radius: CGFloat) {
    clearMorph()
    guard !UIAccessibility.isReduceMotionEnabled,
      let snapshot = surface.resizableSnapshotView(from: surface.bounds,
        afterScreenUpdates: false, withCapInsets: .zero) else { return }
    snapshot.frame = surface.frame
    snapshot.clipsToBounds = true
    snapshot.layer.cornerCurve = .continuous
    snapshot.layer.cornerRadius = radius
    snapshot.isUserInteractionEnabled = false
    morphBlur.frame = snapshot.bounds
    morphBlur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    morphBlur.isUserInteractionEnabled = false
    snapshot.addSubview(morphBlur)
    view.addSubview(snapshot)
    morphSnapshot = snapshot
  }

  private func clearMorph() {
    morphSnapshot?.removeFromSuperview()
    morphSnapshot = nil
    morphBlur.removeFromSuperview()
    morphBlur.effect = nil
  }

  /// The reference's motion, fitted frame by frame to a 60 fps recording of it.
  private enum Motion {
    /// The menu grows out of + on a spring that overshoots by about 1.5%,
    /// peaking 240 ms in: damping ratio 0.8, natural frequency 22 rad/s.
    static var menuOpen: UISpringTimingParameters { spring(damping: 0.8, frequency: 22) }
    /// Menu ↔ panel, both ways: critically damped at 24 rad/s, half way at
    /// 65 ms, 90% at 160 ms.
    static var morph: UISpringTimingParameters { spring(damping: 1, frequency: 24) }
    /// Closing shrinks into + at a steady pace and is gone in 150 ms.
    static var close: UICubicTimingParameters { UICubicTimingParameters(animationCurve: .linear) }
    static let closeDuration: TimeInterval = 0.15
    static func spring(damping: CGFloat, frequency: CGFloat) -> UISpringTimingParameters {
      UISpringTimingParameters(mass: 1, stiffness: frequency * frequency, damping: 2 * damping * frequency,
        initialVelocity: .zero)
    }
  }

  private func animate(_ timing: any UITimingCurveProvider, animations: @escaping () -> Void,
    completion: @escaping () -> Void = {}) {
    transition?.stopAnimation(true)
    transition = nil
    guard !UIAccessibility.isReduceMotionEnabled else { animations(); completion(); return }
    // A spring's own parameters set its length; the duration only applies to a curve.
    let animation = UIViewPropertyAnimator(duration: Motion.closeDuration, timingParameters: timing)
    animation.addAnimations(animations)
    transition = animation
    animation.addCompletion { [weak self, weak animation] _ in
      guard let self, self.transition === animation else { return }
      self.transition = nil
      completion()
    }
    animation.startAnimation()
  }

  /// Outside taps and Files dismiss the entire attachment flow into the + button.
  func collapse(then action: (() -> Void)? = nil) {
    guard !closing else { return }
    closing = true
    if let animation = transition {
      transition = nil
      animation.stopAnimation(false)
      animation.finishAnimation(at: .current)
    }
    view.isUserInteractionEnabled = false
    camera?.stop()
    // Closing without adding returns to typing: the keyboard comes back
    // beneath the still while the card shrinks into +.
    let resumes = action == nil && (still != nil || stage != .menu)
    if resumes { restoreTyping() }
    let target = collapsed(card, into: anchor, scale: 0.14)
    let panelTarget = collapsed(panel, into: anchor, scale: 0.14)
    let snapshotTarget = morphSnapshot.map { collapsed($0, into: anchor, scale: 0.14) }
    guard !UIAccessibility.isReduceMotionEnabled else { finish(action, resumes: resumes); return }
    // The rows leave first, then the glass shrinks into +.
    fadeMenu(in: false)
    // Freeze an interrupted expansion before shrinking both surfaces toward +.
    animate(Motion.close, animations: {
      self.card.transform = target
      if let snapshotTarget { self.morphSnapshot?.transform = snapshotTarget }
      self.morphSnapshot?.alpha = 0
      if self.stage != .menu { self.panel.transform = panelTarget }
      // …and dematerializes as it shrinks back in.
      self.setGlass(false)
      self.panel.alpha = 0
    }, completion: { self.finish(action, resumes: resumes) })
    // Presentations wait for the tray's window to leave.
  }

  /// Add and the shutter: settle into the composer, where the new attachments appear.
  private func settle(then action: @escaping () -> Void) {
    guard !closing else { return }
    closing = true
    view.isUserInteractionEnabled = false
    camera?.stop()
    // Adding focuses the composer; start the keyboard back now, beneath the
    // still, and settle into the composer where the still shows it.
    if still != nil { restoreTyping() }
    let frame = heldComposer ?? actions.composerFrame() ?? source
    action()
    guard !UIAccessibility.isReduceMotionEnabled else { finish(nil, resumes: true); return }
    let radius = min(frame.height / 2, 28)
    animate(Motion.morph, animations: {
      self.card.frame = frame
      self.round(radius)
      self.panelMask.frame = frame.offsetBy(dx: -self.panel.frame.minX, dy: -self.panel.frame.minY)
      self.panelMask.layer.cornerRadius = radius
      self.panel.alpha = 0
      self.setGlass(false)
    }, completion: { self.finish(nil, resumes: true) })
  }

  private func removePicker() {
    picker?.willMove(toParent: nil)
    picker?.view.removeFromSuperview()
    picker?.removeFromParent()
    picker = nil
  }

  private func finish(_ action: (() -> Void)?, resumes: Bool) {
    transition?.stopAnimation(true)
    transition = nil
    clearMorph()
    removePicker()
    releaseStill(typing: resumes) { [weak self] in
      self?.finished()
      action?()
    }
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
    picker?.view.isHidden = false
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
    pickerCover?.removeFromSuperview()
    pickerCover = nil
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
    guard stage == .photos, !closing, transition == nil, presentedViewController == nil else { return }
    if selection.isEmpty {
      var configuration = PHPickerConfiguration()
      configuration.filter = .any(of: [.images, .videos])
      configuration.selectionLimit = max(1, actions.remaining)
      configuration.selection = .ordered
      let fullPicker = PHPickerViewController(configuration: configuration)
      fullPicker.delegate = self
      present(fullPicker, animated: true)
      return
    }
    NativeHaptics.play(.light, source: "composer.attach")
    let picked = selection
    settle { self.actions.photos(picked) }
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    guard !closing else { return }
    guard picker === self.picker else {
      picker.dismiss(animated: true) { [weak self] in
        guard let self, !self.closing, !results.isEmpty else { return }
        self.settle { self.actions.photos(results) }
      }
      return
    }
    let grew = results.count > selection.count
    selection = results
    if grew { NativeHaptics.play(.selection, source: "composer.attach-option") }
    updateAdd(animated: true)
  }

  // MARK: Camera

  private func buildCamera(in bounds: CGRect) {
    picker?.view.isHidden = true
    back.removeFromSuperview()
    add.removeFromSuperview()
    let camera = TrayCamera(frame: bounds)
    camera.back.accessibilityIdentifier = "attach-back"
    camera.back.addAction(UIAction { [weak self] _ in self?.returnToMenu() }, for: .touchUpInside)
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

  override func accessibilityPerformEscape() -> Bool {
    if stage == .menu { collapse() } else { returnToMenu() }
    return true
  }
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
  private var active = false
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

    let shutterSize: CGFloat = 64
    shutter.frame = CGRect(x: (bounds.width - shutterSize) / 2, y: bottom + (control - shutterSize) / 2,
      width: shutterSize, height: shutterSize)
    shutter.backgroundColor = UIColor.white.withAlphaComponent(0.2)
    shutter.layer.cornerRadius = shutterSize / 2
    shutter.layer.borderColor = UIColor.white.withAlphaComponent(0.4).cgColor
    shutter.layer.borderWidth = 1
    let shutterFill = UIView(frame: CGRect(x: 6, y: 6, width: 52, height: 52))
    shutterFill.backgroundColor = .white
    shutterFill.layer.cornerRadius = 26
    shutterFill.isUserInteractionEnabled = false
    shutter.addSubview(shutterFill)
    shutter.accessibilityLabel = "Take photo"
    shutter.accessibilityIdentifier = "attach-shutter"
    shutter.isEnabled = false
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
    active = true
    #if DEBUG
    if let path = UserDefaults.standard.string(forKey: "ui-testing-camera-fixture"),
      AVCaptureDevice.default(for: .video) == nil, let image = UIImage(contentsOfFile: path) {
      still.image = image
      still.isHidden = false
      shutter.isEnabled = true
      return
    }
    #endif
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: configure()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        Task { @MainActor in
          guard self.active else { return }
          granted ? self.configure() : self.show("Allow camera access in Settings to take a photo.")
        }
      }
    default: show("Allow camera access in Settings to take a photo.")
    }
  }
  func stop() {
    active = false
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
        guard self.active else { return }
        self.shutter.isEnabled = true
        UIView.animate(withDuration: 0.25) { self.preview.alpha = 1 }
      }
    }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    still.frame = bounds
    message.frame = bounds.insetBy(dx: 32, dy: 0)
    let control = AttachmentTrayController.control
    let inset = AttachmentTrayController.controlInset
    let bottom = bounds.height - inset - control
    back.frame = CGRect(x: inset, y: bottom, width: control, height: control)
    more.frame = CGRect(x: bounds.width - inset - control, y: bottom, width: control, height: control)
    shutter.center = CGPoint(x: bounds.midX, y: bottom + control / 2)
    for (index, button) in [flip, flash].enumerated() {
      button.frame = more.frame.offsetBy(dx: 0, dy: expanded ? -58 * CGFloat(index + 1) : 0)
    }
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
      guard self.active else { return }
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
