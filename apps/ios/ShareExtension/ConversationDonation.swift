import Intents
import OSLog
import UIKit

/// Sent-message donations let the share sheet suggest individual Bot conversations.
/// The app and the share extension both donate; the extension reads `conversationIdentifier` back.
enum ConversationDonation {
  private static let logger = Logger(subsystem: "dev.openteam.share", category: "donation")
  /// NSCache is thread-safe; keys include `updatedAt`, so a new upload replaces the old photo.
  nonisolated(unsafe) private static let photos = NSCache<NSString, UIImage>()

  /// An uploaded photo wins over the drawn robot, matching the app's avatars.
  static func avatar(channel: Channel, bot: Bot?, api: API?) async -> UIImage? {
    let key = "\(bot?.id ?? channel.id):\(bot?.updatedAt ?? channel.updatedAt)" as NSString
    if let cached = photos.object(forKey: key) { return cached }
    if bot?.hasAvatar ?? channel.hasAvatar, let api {
      let path = bot.map { "/api/v0/bots/\(API.segment($0.id))/avatar" }
        ?? "/api/v0/channels/\(API.segment(channel.id))/avatar"
      if let (data, _) = try? await api.raw(path), let image = UIImage(data: data) {
        photos.setObject(image, forKey: key)
        return image
      }
    }
    return RobotNotificationAvatar.image(icon: bot?.icon, color: bot?.color)
  }

  static func intent(channel: Channel, bot: Bot?, image: UIImage?) -> INSendMessageIntent {
    let name = bot?.name ?? channel.name
    let image = image?.pngData().map { INImage(imageData: $0) }
    let recipients = bot.map {
      [INPerson(personHandle: INPersonHandle(value: $0.id, type: .unknown), nameComponents: nil,
                displayName: $0.name, image: image, contactIdentifier: nil, customIdentifier: $0.id)]
    }
    let intent = INSendMessageIntent(
      recipients: recipients, outgoingMessageType: .outgoingMessageText, content: nil,
      speakableGroupName: INSpeakableString(spokenPhrase: name), conversationIdentifier: channel.id,
      serviceName: "OpenTeam", sender: nil, attachments: nil)
    intent.setImage(image, forParameterNamed: \.speakableGroupName)
    return intent
  }

  /// Signing out or resetting must not leave this account's chats in the share sheet.
  static func forgetAll() {
    INInteraction.deleteAll { error in
      if let error {
        logger.error("Share suggestion removal failed: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  static func donateSent(channel: Channel, bot: Bot?, image: UIImage?) {
    let interaction = INInteraction(intent: intent(channel: channel, bot: bot, image: image), response: nil)
    interaction.direction = .outgoing
    interaction.groupIdentifier = channel.id
    interaction.donate { error in
      if let error {
        logger.error("Share suggestion donation failed: \(error.localizedDescription, privacy: .public)")
      } else {
        logger.notice("Donated share suggestion for \(channel.id, privacy: .public)")
      }
    }
  }
}
