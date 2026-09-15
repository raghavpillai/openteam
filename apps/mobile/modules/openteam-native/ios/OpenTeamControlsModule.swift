import ExpoModulesCore
import UIKit

struct OpenTeamMenuAction: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var symbol: String = ""
  @Field var selected: Bool = false
}

private func glassConfiguration() -> UIButton.Configuration {
  if #available(iOS 26.0, *) { return .glass() }
  return .gray()
}

private func accountAvatar(_ initials: String, diameter: CGFloat) -> UIImage {
  UIGraphicsImageRenderer(size: CGSize(width: diameter, height: diameter)).image { _ in
    UIColor(white: 0.55, alpha: 0.12).setFill()
    UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: diameter, height: diameter)).fill()
    let font = UIFont.systemFont(ofSize: diameter * 0.40, weight: .semibold)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.secondaryLabel]
    let size = initials.size(withAttributes: attributes)
    initials.draw(at: CGPoint(x: (diameter - size.width) / 2, y: (diameter - size.height) / 2), withAttributes: attributes)
  }.withRenderingMode(.alwaysOriginal)
}

final class OpenTeamButtonView: ExpoView {
  let onActivate = EventDispatcher()
  let onAction = EventDispatcher()
  private let button = UIButton(type: .system)
  var symbol = "" { didSet { updateConfiguration() } }
  var initials = "" { didSet { updateConfiguration() } }
  var title = "" { didSet { updateConfiguration() } }
  var variant = "glass" { didSet { updateConfiguration() } }
  var busy = false { didSet { updateConfiguration() } }
  var destructive = false { didSet { updateConfiguration() } }
  var label = "" { didSet { button.accessibilityLabel = label } }
  var symbolSize: Double = 20 { didSet { updateConfiguration() } }
  var disabled = false { didSet { button.isEnabled = !disabled && !busy } }
  var dark = false { didSet {
    overrideUserInterfaceStyle = dark ? .dark : .light
    updateConfiguration()
  } }
  var actions: [OpenTeamMenuAction] = [] { didSet { updateMenu() } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
    addSubview(button)
    button.addAction(UIAction { [weak self] _ in self?.onActivate([:]) }, for: .touchUpInside)
    updateConfiguration()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    button.frame = bounds.insetBy(dx: 2, dy: 2)
  }

  private func updateConfiguration() {
    var configuration: UIButton.Configuration
    switch variant {
    case "filled": configuration = .filled()
    case "tinted": configuration = .tinted()
    case "plain": configuration = .plain()
    default: configuration = glassConfiguration()
    }
    configuration.cornerStyle = .capsule
    if variant == "filled" || variant == "tinted" {
      configuration.baseBackgroundColor = destructive ? .systemRed : .systemBlue
    }
    configuration.baseForegroundColor = variant == "filled" ? .white : destructive ? .systemRed : variant == "glass" ? .label : .systemBlue
    configuration.contentInsets = title.isEmpty ? .zero : NSDirectionalEdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14)
    configuration.title = title.isEmpty || busy ? nil : title
    configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
      var attributes = incoming
      attributes.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(for: .systemFont(ofSize: 15, weight: .semibold))
      return attributes
    }
    configuration.imagePadding = 6
    configuration.showsActivityIndicator = busy
    traitCollection.performAsCurrent {
      configuration.image = initials.isEmpty
        ? (symbol.isEmpty ? nil : UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: symbolSize, weight: .regular)))
        : accountAvatar(initials, diameter: 38)
    }
    button.configuration = configuration
    button.isEnabled = !disabled && !busy
  }

  private func updateMenu() {
    button.showsMenuAsPrimaryAction = !actions.isEmpty
    button.menu = actions.isEmpty ? nil : UIMenu(children: actions.map { item in
      UIAction(title: item.title, image: item.symbol.isEmpty ? nil : UIImage(systemName: item.symbol), state: item.selected ? .on : .off) { [weak self] _ in
        self?.onAction(["id": item.id])
      }
    })
  }
}

public final class OpenTeamButtonModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenTeamButton")
    View(OpenTeamButtonView.self) {
      Events("onActivate", "onAction")
      Prop("symbol") { (view, value: String) in view.symbol = value }
      Prop("initials") { (view, value: String) in view.initials = value }
      Prop("title") { (view, value: String) in view.title = value }
      Prop("variant") { (view, value: String) in view.variant = value }
      Prop("busy") { (view, value: Bool) in view.busy = value }
      Prop("destructive") { (view, value: Bool) in view.destructive = value }
      Prop("label") { (view, value: String) in view.label = value }
      Prop("symbolSize") { (view, value: Double) in view.symbolSize = value }
      Prop("disabled") { (view, value: Bool) in view.disabled = value }
      Prop("dark") { (view, value: Bool) in view.dark = value }
      Prop("actions") { (view, value: [OpenTeamMenuAction]) in view.actions = value }
    }
  }
}

struct OpenTeamSettingsRow: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var subtitle: String = ""
  @Field var detail: String = ""
  @Field var initials: String = ""
  @Field var symbol: String = ""
  @Field var kind: String = "button"
  @Field var value: Bool = false
  @Field var disabled: Bool = false
  @Field var destructive: Bool = false
}

struct OpenTeamSettingsSection: Record {
  @Field var title: String = ""
  @Field var footer: String = ""
  @Field var rows: [OpenTeamSettingsRow] = []
}

final class OpenTeamSettingsView: ExpoView, UITableViewDataSource, UITableViewDelegate {
  let onAction = EventDispatcher()
  private let table = UITableView(frame: .zero, style: .insetGrouped)
  private let closeButton = UIButton(type: .system)
  var sections: [OpenTeamSettingsSection] = [] { didSet { table.reloadData() } }
  var dark = false { didSet {
    overrideUserInterfaceStyle = dark ? .dark : .light
    backgroundColor = dark ? UIColor(white: 0.078, alpha: 1) : UIColor(white: 0.988, alpha: 1)
    table.reloadData()
  } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = UIColor(white: 0.988, alpha: 1)
    table.backgroundColor = .clear
    table.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
    table.insetsLayoutMarginsFromSafeArea = false
    table.sectionHeaderTopPadding = 0
    table.dataSource = self
    table.delegate = self
    table.rowHeight = UITableView.automaticDimension
    table.estimatedRowHeight = 0
    table.estimatedSectionHeaderHeight = 0
    table.estimatedSectionFooterHeight = 0
    table.contentInsetAdjustmentBehavior = .never
    table.keyboardDismissMode = .interactive
    var configuration = glassConfiguration()
    configuration.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
    configuration.cornerStyle = .capsule
    configuration.baseForegroundColor = .label
    closeButton.configuration = configuration
    closeButton.accessibilityLabel = "Close settings"
    closeButton.addAction(UIAction { [weak self] _ in self?.onAction(["id": "close"]) }, for: .touchUpInside)
    addSubview(table)
    addSubview(closeButton)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    closeButton.frame = CGRect(x: 16, y: 18, width: 44, height: 44)
    let tableTop: CGFloat = 92
    table.frame = CGRect(x: 0, y: tableTop, width: bounds.width, height: max(0, bounds.height - tableTop))
    table.contentInset.bottom = 24
  }

  func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat {
    if section == 0 { return 0.01 }
    return sections[section].title.isEmpty ? 28 : 52
  }
  func tableView(_ tableView: UITableView, viewForHeaderInSection section: Int) -> UIView? {
    let view = UIView()
    guard !sections[section].title.isEmpty else { return view }
    let label = UILabel(frame: CGRect(x: 32, y: 28, width: max(0, bounds.width - 60), height: 17))
    label.text = sections[section].title
    label.font = .preferredFont(forTextStyle: .footnote)
    label.textColor = .tertiaryLabel
    label.accessibilityTraits = .header
    view.addSubview(label)
    return view
  }
  func tableView(_ tableView: UITableView, heightForFooterInSection section: Int) -> CGFloat {
    sections[section].footer.isEmpty ? 0.01 : UITableView.automaticDimension
  }
  func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
    let row = sections[indexPath.section].rows[indexPath.row]
    let base: CGFloat = row.kind == "profile" ? 84 : row.subtitle.isEmpty ? 48 : 68
    return UIFontMetrics(forTextStyle: .body).scaledValue(for: base)
  }

  func numberOfSections(in tableView: UITableView) -> Int { sections.count }
  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { sections[section].rows.count }
  func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
    sections[section].title.isEmpty ? nil : sections[section].title
  }
  func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
    sections[section].footer.isEmpty ? nil : sections[section].footer
  }
  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let row = sections[indexPath.section].rows[indexPath.row]
    let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
    var content = row.detail.isEmpty ? UIListContentConfiguration.subtitleCell() : UIListContentConfiguration.valueCell()
    content.text = row.title
    content.secondaryText = row.detail.isEmpty ? (row.subtitle.isEmpty ? nil : row.subtitle) : row.detail
    content.textProperties.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17, weight: row.kind == "profile" ? .medium : .regular))
    content.secondaryTextProperties.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(for: .systemFont(ofSize: row.detail.isEmpty ? 14 : 16))
    content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 10, leading: 18, bottom: 10, trailing: 18)
    content.textProperties.color = row.destructive ? .systemRed : .label
    content.textProperties.numberOfLines = 0
    content.secondaryTextProperties.color = .secondaryLabel
    content.secondaryTextProperties.numberOfLines = 0
    content.image = row.kind == "profile" ? accountAvatar(row.initials.isEmpty ? "OT" : row.initials, diameter: 38) : nil
    content.imageProperties.tintColor = .secondaryLabel
    content.imageProperties.maximumSize = CGSize(width: 38, height: 38)
    cell.contentConfiguration = content
    var background = UIBackgroundConfiguration.listGroupedCell()
    background.backgroundColor = dark ? UIColor(white: 0.125, alpha: 1) : UIColor(white: 0.949, alpha: 1)
    background.cornerRadius = 16
    cell.backgroundConfiguration = background
    cell.accessibilityIdentifier = "settings-\(row.id)"
    cell.selectionStyle = row.kind == "info" || row.disabled ? .none : .default
    if row.kind == "toggle" {
      let toggle = UISwitch()
      toggle.isOn = row.value
      toggle.isEnabled = !row.disabled
      toggle.accessibilityLabel = row.title
      toggle.addAction(UIAction { [weak self, weak toggle] _ in
        let requestedValue = toggle?.isOn ?? false
        toggle?.setOn(row.value, animated: true)
        self?.onAction(["id": row.id, "value": requestedValue])
      }, for: .valueChanged)
      cell.accessoryView = toggle
      cell.isAccessibilityElement = false
      cell.accessibilityElements = [toggle]
      cell.selectionStyle = .none
    } else if (row.kind == "button" || row.kind == "profile") && !row.destructive {
      cell.accessoryType = .disclosureIndicator
    }
    return cell
  }
  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: true)
    let row = sections[indexPath.section].rows[indexPath.row]
    guard row.kind == "button" || row.kind == "profile", !row.disabled else { return }
    onAction(["id": row.id])
  }
}

public final class OpenTeamSettingsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenTeamSettings")
    View(OpenTeamSettingsView.self) {
      Events("onAction")
      Prop("sections") { (view, value: [OpenTeamSettingsSection]) in view.sections = value }
      Prop("dark") { (view, value: Bool) in view.dark = value }
    }
  }
}
