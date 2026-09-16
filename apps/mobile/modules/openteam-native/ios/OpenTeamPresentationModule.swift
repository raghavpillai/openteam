import ExpoModulesCore
import UIKit

// These four silhouettes differ from the nearest SF Symbols. Keep the native
// button, tint and accessibility behavior, with the reference's 16 pt artwork
// centered in the same 20 pt action column.
private func messageActionIcon(_ id: String) -> UIImage? {
  guard ["reply", "thread", "unread", "copy"].contains(id) else { return nil }
  return UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in
    UIColor.black.setStroke()
    UIColor.black.setFill()
    let path = UIBezierPath()
    path.lineWidth = 1.65
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    switch id {
    case "reply":
      path.move(to: CGPoint(x: 6.5, y: 4))
      path.addLine(to: CGPoint(x: 2.5, y: 8))
      path.addLine(to: CGPoint(x: 6.5, y: 12))
      path.move(to: CGPoint(x: 3, y: 8))
      path.addLine(to: CGPoint(x: 12, y: 8))
      path.addCurve(to: CGPoint(x: 12, y: 16), controlPoint1: CGPoint(x: 19, y: 8), controlPoint2: CGPoint(x: 19, y: 16))
      path.addLine(to: CGPoint(x: 9, y: 16))
    case "thread":
      path.move(to: CGPoint(x: 6.5, y: 7.5))
      path.addCurve(to: CGPoint(x: 2.5, y: 13), controlPoint1: CGPoint(x: 4, y: 8), controlPoint2: CGPoint(x: 2.5, y: 10))
      path.addLine(to: CGPoint(x: 2.5, y: 18))
      path.addLine(to: CGPoint(x: 7, y: 18))
      path.addCurve(to: CGPoint(x: 12, y: 13.5), controlPoint1: CGPoint(x: 10, y: 18), controlPoint2: CGPoint(x: 12, y: 16))
      path.move(to: CGPoint(x: 18, y: 8))
      path.addCurve(to: CGPoint(x: 12.25, y: 2.5), controlPoint1: CGPoint(x: 18, y: 4.8), controlPoint2: CGPoint(x: 15.5, y: 2.5))
      path.addCurve(to: CGPoint(x: 6.5, y: 8), controlPoint1: CGPoint(x: 9, y: 2.5), controlPoint2: CGPoint(x: 6.5, y: 4.8))
      path.addCurve(to: CGPoint(x: 12.25, y: 13.5), controlPoint1: CGPoint(x: 6.5, y: 11.2), controlPoint2: CGPoint(x: 9, y: 13.5))
      path.addLine(to: CGPoint(x: 18, y: 13.5))
      path.close()
    case "unread":
      path.move(to: CGPoint(x: 11, y: 3))
      path.addLine(to: CGPoint(x: 4, y: 3))
      path.addQuadCurve(to: CGPoint(x: 2.5, y: 4.5), controlPoint: CGPoint(x: 2.5, y: 3))
      path.addLine(to: CGPoint(x: 2.5, y: 13))
      path.addQuadCurve(to: CGPoint(x: 4, y: 14.5), controlPoint: CGPoint(x: 2.5, y: 14.5))
      path.addLine(to: CGPoint(x: 7.5, y: 14.5))
      path.addLine(to: CGPoint(x: 10, y: 18))
      path.addLine(to: CGPoint(x: 12.5, y: 14.5))
      path.addLine(to: CGPoint(x: 16, y: 14.5))
      path.addQuadCurve(to: CGPoint(x: 17.5, y: 13), controlPoint: CGPoint(x: 17.5, y: 14.5))
      path.addLine(to: CGPoint(x: 17.5, y: 9.5))
      UIBezierPath(ovalIn: CGRect(x: 14, y: 2.5, width: 4.5, height: 4.5)).fill()
    case "copy":
      path.append(UIBezierPath(roundedRect: CGRect(x: 6, y: 2.5, width: 11.5, height: 11.5), cornerRadius: 1.2))
      path.move(to: CGPoint(x: 2.5, y: 7))
      path.addLine(to: CGPoint(x: 2.5, y: 16.5))
      path.addQuadCurve(to: CGPoint(x: 4, y: 18), controlPoint: CGPoint(x: 2.5, y: 18))
      path.addLine(to: CGPoint(x: 13, y: 18))
    default: break
    }
    path.stroke()
  }.withRenderingMode(.alwaysTemplate)
}

private func menuElements(_ items: [[String: Any]], action: @escaping (String) -> Void)
  -> [UIMenuElement]
{
  items.map { item in
    let title = item["title"] as? String ?? ""
    let symbol = item["symbol"] as? String ?? ""
    let image = symbol.isEmpty ? nil : UIImage(systemName: symbol)
    if let children = item["children"] as? [[String: Any]] {
      return UIMenu(
        title: title, image: image, options: item["inline"] as? Bool == true ? .displayInline : [],
        children: menuElements(children, action: action))
    }
    return UIAction(
      title: title, image: image,
      attributes: item["destructive"] as? Bool == true ? .destructive : [],
      state: item["selected"] as? Bool == true ? .on : .off
    ) { _ in action(item["id"] as? String ?? "") }
  }
}

final class OpenTeamContextMenuView: ExpoView, UIContextMenuInteractionDelegate {
  let onAction = EventDispatcher()
  let onActivate = EventDispatcher()
  var menuJSON = "[]"
  var dark = false { didSet { overrideUserInterfaceStyle = dark ? .dark : .light } }
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isAccessibilityElement = true
    accessibilityTraits = .button
    addInteraction(UIContextMenuInteraction(delegate: self))
  }
  override func accessibilityActivate() -> Bool {
    onActivate([:])
    return true
  }
  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let data = menuJSON.data(using: .utf8),
      let items = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], !items.isEmpty
    else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      UIMenu(children: menuElements(items) { id in self?.onAction(["id": id]) })
    }
  }
  private func preview() -> UITargetedPreview {
    let parameters = UIPreviewParameters()
    parameters.backgroundColor =
      dark ? UIColor(white: 0.078, alpha: 1) : UIColor(white: 0.988, alpha: 1)
    parameters.visiblePath = UIBezierPath(roundedRect: bounds, cornerRadius: 12)
    return UITargetedPreview(view: self, parameters: parameters)
  }
  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? { preview() }
  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? { preview() }
}

public final class OpenTeamContextMenuModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenTeamContextMenu")
    View(OpenTeamContextMenuView.self) {
      Events("onAction", "onActivate")
      Prop("menuJSON") { (view, value: String) in view.menuJSON = value }
      Prop("dark") { (view, value: Bool) in view.dark = value }
    }
  }
}

// UIKit owns the presentation, grabber, interactive dismissal, and button feedback.
private final class MessageActionsController: UIViewController {
  var actions: [[String: Any]] = []
  var reactions: [String] = []
  var choose: ((String) -> Void)?
  var dark = false
  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private var surface: UIColor {
    dark ? UIColor(white: 0.125, alpha: 1) : UIColor(white: 0.949, alpha: 1)
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    overrideUserInterfaceStyle = dark ? .dark : .light
    view.backgroundColor = dark ? UIColor(white: 0.078, alpha: 1) : UIColor(white: 0.988, alpha: 1)
    scroll.translatesAutoresizingMaskIntoConstraints = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.axis = .vertical
    stack.spacing = 12
    view.addSubview(scroll)
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.topAnchor, constant: 24),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -16),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(
        equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -16),
    ])
    if !reactions.isEmpty {
      let grid = UIStackView()
      grid.axis = .vertical
      grid.spacing = 12
      let values = reactions + ["more-reactions"]
      for start in stride(from: 0, to: values.count, by: 6) {
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .equalSpacing
        for value in values[start..<min(start + 6, values.count)] {
          let button = UIButton(type: .system)
          var config = UIButton.Configuration.gray()
          config.cornerStyle = .capsule
          config.baseBackgroundColor = surface
          if value == "more-reactions" {
            config.image = UIImage(
              systemName: "face.smiling",
              withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .regular))
            config.baseForegroundColor = .secondaryLabel
          } else {
            config.title = value
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
              old in
              var a = old
              a.font = .systemFont(ofSize: 22)
              return a
            }
          }
          button.configuration = config
          if value == "more-reactions" {
            let badge = UILabel()
            badge.text = "+"
            badge.font = .systemFont(ofSize: 11, weight: .medium)
            badge.textColor = .secondaryLabel
            badge.textAlignment = .center
            badge.backgroundColor = surface
            badge.layer.cornerRadius = 6
            badge.clipsToBounds = true
            badge.isAccessibilityElement = false
            badge.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(badge)
            NSLayoutConstraint.activate([
              badge.widthAnchor.constraint(equalToConstant: 12),
              badge.heightAnchor.constraint(equalToConstant: 12),
              badge.centerXAnchor.constraint(equalTo: button.centerXAnchor, constant: 9),
              badge.centerYAnchor.constraint(equalTo: button.centerYAnchor, constant: 8),
            ])
          }
          button.accessibilityLabel =
            value == "more-reactions" ? "More reactions" : "React \(value)"
          button.addAction(
            UIAction { [weak self] _ in
              self?.choose?(value == "more-reactions" ? value : "reaction:\(value)")
            }, for: .touchUpInside)
          button.widthAnchor.constraint(equalToConstant: 44).isActive = true
          button.heightAnchor.constraint(equalToConstant: 44).isActive = true
          row.addArrangedSubview(button)
        }
        grid.addArrangedSubview(row)
      }
      grid.layoutMargins = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
      grid.isLayoutMarginsRelativeArrangement = true
      stack.addArrangedSubview(grid)
    }
    var group: UIStackView?
    for item in actions {
      if group == nil || item["separate"] as? Bool == true {
        let card = UIStackView()
        card.axis = .vertical
        card.backgroundColor = surface
        card.layer.cornerRadius = 16
        card.clipsToBounds = true
        stack.addArrangedSubview(card)
        group = card
      } else if let group {
        let line = UIView()
        line.backgroundColor =
          dark ? UIColor(white: 1, alpha: 0.09) : UIColor(white: 0, alpha: 0.08)
        let inset = UIView()
        inset.addSubview(line)
        line.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
          inset.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
          line.leadingAnchor.constraint(equalTo: inset.leadingAnchor, constant: 50),
          line.trailingAnchor.constraint(equalTo: inset.trailingAnchor),
          line.topAnchor.constraint(equalTo: inset.topAnchor),
          line.bottomAnchor.constraint(equalTo: inset.bottomAnchor),
        ])
        group.addArrangedSubview(inset)
      }
      let button = UIButton(type: .system)
      var config = UIButton.Configuration.plain()
      config.title = item["title"] as? String
      let symbol = UIImage(
        systemName: item["symbol"] as? String ?? "",
        withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
        ?? UIImage(systemName: "bubble.left")!
      // SF Symbols have different optical bounds. Fit each in the same 20-point
      // column instead of letting its intrinsic width move the action label.
      let iconSize = CGSize(width: 20, height: 20)
      config.image = messageActionIcon(item["id"] as? String ?? "") ?? UIGraphicsImageRenderer(size: iconSize).image { _ in
        let scale = min(iconSize.width / symbol.size.width, iconSize.height / symbol.size.height)
        let size = CGSize(width: symbol.size.width * scale, height: symbol.size.height * scale)
        symbol.draw(in: CGRect(x: (20 - size.width) / 2, y: (20 - size.height) / 2,
                              width: size.width, height: size.height))
      }.withRenderingMode(.alwaysTemplate)
      config.baseForegroundColor = item["destructive"] as? Bool == true ? .systemRed : .label
      config.imagePadding = 10
      config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20)
      config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { old in
        var a = old
        a.font = UIFontMetrics(forTextStyle: .body).scaledFont(
          for: .systemFont(ofSize: 17, weight: .regular))
        return a
      }
      button.configuration = config
      button.contentHorizontalAlignment = .leading
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
      button.addAction(
        UIAction { [weak self] _ in self?.choose?(item["id"] as? String ?? "") },
        for: .touchUpInside)
      group?.addArrangedSubview(button)
    }
  }
}

final class OpenTeamMessageActionsView: ExpoView, UIAdaptivePresentationControllerDelegate {
  let onAction = EventDispatcher()
  let onDismiss = EventDispatcher()
  var actionsJSON = "[]"
  var reactions: [String] = []
  var dark = false
  var visible = false { didSet { updatePresentation() } }
  private var controller: MessageActionsController?
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      controller?.dismiss(animated: false)
      controller = nil
    } else {
      updatePresentation()
    }
  }
  private func updatePresentation() {
    if !visible {
      if let controller {
        controller.dismiss(animated: true)
        self.controller = nil
      }
      return
    }
    guard window != nil, controller == nil else { return }
    // Expo props and React mounting finish before the controller reads its configuration.
    DispatchQueue.main.async { [weak self] in self?.presentActions() }
  }
  private func presentActions() {
    guard visible, window != nil, controller == nil else { return }
    var responder: UIResponder? = self
    while responder != nil && !(responder is UIViewController) { responder = responder?.next }
    guard var presenter = responder as? UIViewController else { return }
    while let presented = presenter.presentedViewController { presenter = presented }
    let sheet = MessageActionsController()
    sheet.dark = dark
    sheet.reactions = reactions
    if let data = actionsJSON.data(using: .utf8),
      let actions = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    {
      sheet.actions = actions
    }
    sheet.choose = { [weak self, weak sheet] id in
      sheet?.dismiss(animated: true) {
        self?.controller = nil
        self?.onAction(["id": id])
      }
    }
    sheet.modalPresentationStyle = .pageSheet
    if let presentation = sheet.sheetPresentationController {
      presentation.detents = [
        .custom(identifier: .init("messageActions")) { context in
          min(344, context.maximumDetentValue)
        }
      ]
      presentation.prefersGrabberVisible = true
      presentation.preferredCornerRadius = 40
      presentation.prefersScrollingExpandsWhenScrolledToEdge = false
    }
    sheet.presentationController?.delegate = self
    controller = sheet
    presenter.present(sheet, animated: true)
  }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    controller = nil
    onDismiss([:])
  }
}

public final class OpenTeamMessageActionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenTeamMessageActions")
    View(OpenTeamMessageActionsView.self) {
      Events("onAction", "onDismiss")
      Prop("visible") { (view, value: Bool) in view.visible = value }
      Prop("dark") { (view, value: Bool) in view.dark = value }
      Prop("actionsJSON") { (view, value: String) in view.actionsJSON = value }
      Prop("reactions") { (view, value: [String]) in view.reactions = value }
    }
  }
}
