import Foundation

/// The same common schedule choices as desktop. Cron stays a transport detail.
public struct RoutineScheduleDraft: Equatable, Sendable {
  public enum Frequency: String, CaseIterable, Sendable {
    case hourly, daily, weekdays, weekly, monthly, interval, existing
    public var label: String {
      switch self {
      case .hourly: "Every hour"
      case .daily: "Every day"
      case .weekdays: "Weekdays"
      case .weekly: "Every week"
      case .monthly: "Every month"
      case .interval: "Interval"
      case .existing: "Existing schedule"
      }
    }
  }
  public enum IntervalUnit: String, CaseIterable, Sendable {
    case minutes = "m"
    case hours = "h"
    case days = "d"
    public var label: String {
      switch self {
      case .minutes: "minutes"
      case .hours: "hours"
      case .days: "days"
      }
    }
    public var amounts: [Int] {
      switch self {
      case .minutes: [5, 10, 15, 20, 30, 45]
      case .hours: [1, 2, 3, 4, 6, 8, 12]
      case .days: [1, 2, 3, 7, 14, 30]
      }
    }
  }
  public var frequency: Frequency = .weekdays
  public var minute = 0
  /// Wall-clock minutes after midnight, independent of today's DST offset.
  public var time = 8 * 60
  public var weekDay = 1
  public var monthDay = 1
  public var intervalAmount = 30
  public var intervalUnit: IntervalUnit = .minutes
  public private(set) var existingSchedule: String?
  public private(set) var zonePrefix: String?
  public var pinnedTimeZone: String? { zonePrefix.map { String($0.split(separator: "=")[1]) } }

  public init() {}

  public init(schedule: String) {
    self.init()
    existingSchedule = schedule
    frequency = .existing
    var fields = schedule.split(whereSeparator: \.isWhitespace).map(String.init)
    if let first = fields.first,
      first.hasPrefix("CRON_TZ=") || first.hasPrefix("TZ="),
      first.split(separator: "=", omittingEmptySubsequences: false).count == 2,
      !first.hasSuffix("=")
    {
      zonePrefix = fields.removeFirst()
    }
    if fields.count == 2, fields[0] == "@every",
      let suffix = fields[1].last, let unit = IntervalUnit(rawValue: String(suffix)),
      let amount = Self.integer(String(fields[1].dropLast()), in: 1...Int.max)
    {
      frequency = .interval
      intervalAmount = amount
      intervalUnit = unit
      return
    }
    guard fields.count == 5,
      let minute = Self.integer(fields[0], in: 0...59), fields[3] == "*"
    else { return }
    self.minute = minute
    if fields[1] == "*", fields[2] == "*", fields[4] == "*" {
      frequency = .hourly
      return
    }
    guard let hour = Self.integer(fields[1], in: 0...23) else { return }
    time = hour * 60 + minute
    if fields[2] == "*" {
      if fields[4] == "*" {
        frequency = .daily
      } else if fields[4] == "1-5" {
        frequency = .weekdays
      } else if let day = Self.integer(fields[4], in: 0...7) {
        frequency = .weekly
        weekDay = day % 7
      }
    } else if fields[4] == "*", let day = Self.integer(fields[2], in: 1...31) {
      frequency = .monthly
      monthDay = day
    }
    // Never reinterpret a restricted month, combined day/week rule, or a group as a simple preset.
  }

  private static func integer(_ text: String, in bounds: ClosedRange<Int>) -> Int? {
    guard !text.isEmpty, text.utf8.allSatisfy({ (48...57).contains($0) }),
      let value = Int(text), bounds.contains(value)
    else { return nil }
    return value
  }

  public mutating func changeUnit(to unit: IntervalUnit) {
    intervalUnit = unit
    if !unit.amounts.contains(intervalAmount) { intervalAmount = unit == .minutes ? 30 : 1 }
  }

  /// Extra values from existing schedules remain selectable instead of being rounded away.
  public static func options(_ defaults: [Int], including current: Int) -> [Int] {
    Array(Set(defaults + [current])).sorted()
  }

  public func scheduleValue(newTimeZone: String? = nil) -> String {
    let schedule: String
    switch frequency {
    case .hourly: schedule = "\(minute) * * * *"
    case .daily: schedule = "\(time % 60) \(time / 60) * * *"
    case .weekdays: schedule = "\(time % 60) \(time / 60) * * 1-5"
    case .weekly: schedule = "\(time % 60) \(time / 60) * * \(weekDay)"
    case .monthly: schedule = "\(time % 60) \(time / 60) \(monthDay) * *"
    case .interval: return "@every \(intervalAmount)\(intervalUnit.rawValue)"
    case .existing: return existingSchedule ?? ""
    }
    if let prefix = zonePrefix ?? newTimeZone.map({ "CRON_TZ=\($0)" }) {
      return "\(prefix) \(schedule)"
    }
    return schedule
  }

  /// An unrelated edit must not normalize a saved schedule or replace a richer trigger.
  public func scheduleUpdate(original: String?, editable: Bool, newTimeZone: String) -> String? {
    guard editable else { return nil }
    guard let original else { return scheduleValue(newTimeZone: newTimeZone) }
    guard scheduleValue() != Self(schedule: original).scheduleValue() else { return nil }
    return scheduleValue()
  }

  public func summary(locale: Locale = .current) -> String {
    let at = Self.timeLabel(time, locale: locale)
    switch frequency {
    case .hourly: return minute == 0 ? "Every hour" : String(format: "Every hour at :%02d", minute)
    case .daily: return "Every day at \(at)"
    case .weekdays: return "On weekdays at \(at)"
    case .weekly: return "Every \(Self.weekDays(locale: locale)[weekDay]) at \(at)"
    case .monthly: return "Monthly on the \(Self.ordinal(monthDay)) at \(at)"
    case .interval:
      let unit = intervalAmount == 1 ? String(intervalUnit.label.dropLast()) : intervalUnit.label
      return "Every \(intervalAmount) \(unit)"
    case .existing: return "Custom schedule"
    }
  }

  public static func timeLabel(_ minutes: Int, locale: Locale = .current) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.setLocalizedDateFormatFromTemplate("jm")
    return formatter.string(from: Date(timeIntervalSince1970: Double(minutes * 60)))
  }
  public static func weekDays(locale: Locale = .current) -> [String] {
    let formatter = DateFormatter()
    formatter.locale = locale
    return formatter.weekdaySymbols
  }
  public static func ordinal(_ day: Int) -> String {
    let suffix: String
    switch day % 100 {
    case 11...13: suffix = "th"
    default:
      switch day % 10 {
      case 1: suffix = "st"
      case 2: suffix = "nd"
      case 3: suffix = "rd"
      default: suffix = "th"
      }
    }
    return "\(day)\(suffix)"
  }
}

extension Routine {
  public var scheduleSummary: String {
    if scheduleKind == "event" { return "On an event" }
    if let schedules, schedules.count > 1 {
      return schedules.map { RoutineScheduleDraft(schedule: $0).summary() }.joined(
        separator: " or ")
    }
    if trigger?["type"].string == "group" { return "Multiple triggers" }
    return RoutineScheduleDraft(schedule: schedule).summary()
  }
}
