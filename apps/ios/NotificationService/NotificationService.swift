import Intents
import OSLog
import UIKit
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private let logger = Logger(subsystem: "dev.openteam.notifications", category: "communication")
  private let lock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest,
                           withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    lock.lock()
    handler = contentHandler
    fallback = request.content
    lock.unlock()
    // Expo puts custom data under body; direct APNs and local tests use data or root.
    let info = request.content.userInfo
    let data = (info["body"] as? [String: Any]) ?? (info["data"] as? [String: Any]) ?? (info as? [String: Any]) ?? [:]
    guard ["message", "reaction", "agent-needs-input", "agent-done"].contains(data["kind"] as? String ?? ""),
          let botId = data["botId"] as? String,
          let channelId = data["channelId"] as? String,
          let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      finish(request.content)
      return
    }
    let identity = data["sender"] as? [String: String] ?? [:]
    let name = identity["name"] ?? content.title
    let avatar = RobotNotificationAvatar.image(icon: identity["icon"], color: identity["color"])
    let sender = INPerson(personHandle: INPersonHandle(value: botId, type: .unknown),
                          nameComponents: nil, displayName: name,
                          image: avatar.flatMap { $0.pngData() }.map { INImage(imageData: $0) },
                          contactIdentifier: nil, customIdentifier: botId)
    let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
                                    content: content.body, speakableGroupName: nil,
                                    conversationIdentifier: channelId, serviceName: "OpenTeam",
                                    sender: sender, attachments: nil)
    content.title = name
    content.threadIdentifier = channelId
    lock.lock()
    fallback = content
    lock.unlock()
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.identifier = "\(channelId):\(data["notificationSequence"] as? String ?? request.identifier)"
    interaction.donate { [weak self] error in
      guard let self else { return }
      if let error {
        self.logger.error("Communication intent donation failed: \(error.localizedDescription, privacy: .public)")
        self.finish(content)
        return
      }
      do {
        self.finish(try content.updating(from: intent))
      } catch {
        self.logger.error("Communication content update failed: \(error.localizedDescription, privacy: .public)")
        self.finish(content)
      }
    }
  }

  // A donation error or the extension deadline must never lose the original alert.
  private func finish(_ content: UNNotificationContent) {
    lock.lock()
    let callback = handler
    handler = nil
    lock.unlock()
    callback?(content)
  }

  override func serviceExtensionTimeWillExpire() {
    lock.lock()
    let content = fallback
    lock.unlock()
    if let content { finish(content) }
  }
}
