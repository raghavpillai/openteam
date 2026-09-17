import SwiftUI

struct RoutineScheduleFields: View {
  @Binding var draft: RoutineScheduleDraft
  let timeZone: String

  var body: some View {
    Picker("Frequency", selection: $draft.frequency.hapticSelection("routine.frequency")) {
      ForEach(RoutineScheduleDraft.Frequency.allCases, id: \.self) { frequency in
        if frequency != .existing
          || draft.existingSchedule.map({
            RoutineScheduleDraft(schedule: $0).frequency == .existing
          }) == true
        {
          Text(frequency.label).tag(frequency)
        }
      }
    }.pickerStyle(.menu).accessibilityIdentifier("routine-frequency")

    switch draft.frequency {
    case .hourly:
      Picker("Minute", selection: $draft.minute.hapticSelection("routine.minute")) {
        ForEach(
          RoutineScheduleDraft.options(
            Array(stride(from: 0, through: 55, by: 5)), including: draft.minute), id: \.self
        ) { minute in
          Text(String(format: ":%02d", minute)).tag(minute)
        }
      }.pickerStyle(.menu).accessibilityIdentifier("routine-minute")
    case .daily, .weekdays:
      timePicker
    case .weekly:
      Picker("Day of week", selection: $draft.weekDay.hapticSelection("routine.weekday")) {
        ForEach(Array(RoutineScheduleDraft.weekDays().enumerated()), id: \.offset) { index, day in
          Text(day).tag(index)
        }
      }.pickerStyle(.menu).accessibilityIdentifier("routine-weekday")
      timePicker
    case .monthly:
      Picker("Day of month", selection: $draft.monthDay.hapticSelection("routine.month-day")) {
        ForEach(1...31, id: \.self) { day in Text(RoutineScheduleDraft.ordinal(day)).tag(day) }
      }.pickerStyle(.menu).accessibilityIdentifier("routine-month-day")
      timePicker
      if draft.monthDay > 28 {
        Text("Runs only in months with a \(RoutineScheduleDraft.ordinal(draft.monthDay)) day.")
          .font(.caption).foregroundStyle(NativePalette.muted)
      }
    case .interval:
      Picker("Every", selection: $draft.intervalAmount.hapticSelection("routine.interval-amount")) {
        ForEach(
          RoutineScheduleDraft.options(draft.intervalUnit.amounts, including: draft.intervalAmount),
          id: \.self
        ) { amount in
          Text("\(amount)").tag(amount)
        }
      }.pickerStyle(.menu).accessibilityIdentifier("routine-interval-amount")
      Picker(
        "Unit",
        selection: Binding(get: { draft.intervalUnit }, set: { draft.changeUnit(to: $0) })
          .hapticSelection("routine.interval-unit")
      ) {
        ForEach(RoutineScheduleDraft.IntervalUnit.allCases, id: \.self) { unit in
          Text(unit.label).tag(unit)
        }
      }.pickerStyle(.menu).accessibilityIdentifier("routine-interval-unit")
    case .existing:
      Text(
        "Keep this schedule, or choose a frequency to replace it. More scheduling options are available on desktop."
      )
      .font(.caption).foregroundStyle(NativePalette.muted)
    }
    VStack(alignment: .leading, spacing: 4) {
      Text(draft.summary()).accessibilityIdentifier("routine-schedule-summary")
      if draft.frequency != .interval {
        Text("Time zone: \(draft.pinnedTimeZone ?? timeZone)").font(.caption)
      }
    }.foregroundStyle(NativePalette.muted)
  }

  private var timePicker: some View {
    Picker("Time", selection: $draft.time.hapticSelection("routine.time")) {
      ForEach(
        RoutineScheduleDraft.options(
          Array(stride(from: 0, to: 1440, by: 15)), including: draft.time), id: \.self
      ) { time in
        Text(RoutineScheduleDraft.timeLabel(time)).tag(time)
      }
    }.pickerStyle(.menu).accessibilityIdentifier("routine-time")
  }
}
