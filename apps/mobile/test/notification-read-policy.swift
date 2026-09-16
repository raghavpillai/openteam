import Foundation

@main
enum NotificationReadPolicyTest {
  static func main() {
    let read = ["lastReadSequence": "9007199254740993", "lastReadNotificationSequence": "12"]
    assert(OpenTeamNotificationReads.isRead(["kind": "message", "messageSequence": "9007199254740993"], read))
    assert(!OpenTeamNotificationReads.isRead(["kind": "message", "messageSequence": "9007199254740994"], read))
    assert(!OpenTeamNotificationReads.isRead(["kind": "reaction", "messageSequence": "1", "notificationSequence": "13"], read))
    assert(OpenTeamNotificationReads.isRead(["kind": "reaction", "messageSequence": "1", "notificationSequence": "12"], read))
    assert(!OpenTeamNotificationReads.isRead(["kind": "reaction", "notificationSequence": "invalid"], read))
    assert(OpenTeamNotificationReads.data(["body": ["kind": "badge-sync"]])["kind"] as? String == "badge-sync")
    print("Native notification read policy: 6 checks passed")
  }
}
