import Foundation

/// Portable BotRecipe payload. Account data, memories and connector credentials
/// are excluded from a profile export.
public enum BotTemplateExport {
  public static func recipe(bot: Bot, routines: [Routine]) -> JSON {
    let hasInstructions = !bot.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    var fields: [String: JSON] = [
      "profile": .object([
        "name": .string(bot.name),
        "description": .string(bot.description.isEmpty ? bot.name : bot.description),
        "avatarColor": .string(bot.color), "avatarShape": .string(bot.icon),
      ]),
      "visibility": .string("team"), "memory": .array([]), "plugins": .array([]),
      "skills": .array(hasInstructions ? [.object([
        "name": .string("Instructions"), "description": .string("Bot instructions"),
        "content": .string("# Instructions\n\n" + bot.instructions),
      ])] : []),
      "routines": .array(routines.map { routine in .object([
        "slug": .string(routine.id), "name": .string(routine.name),
        "description": .string(routine.scheduleSummary),
        "content": .string("Schedule: \(routine.scheduleSummary)\nTime zone: \(routine.timezone)\n\n" + routine.prompt),
      ]) }),
    ]
    if hasInstructions { fields["gettingStarted"] = .object(["skill": .string("Instructions")]) }
    return .object(fields)
  }
}
