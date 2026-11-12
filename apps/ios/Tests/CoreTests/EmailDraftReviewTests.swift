import XCTest
@testable import OpenTeamCore

final class EmailDraftReviewTests: XCTestCase {
  func testRecipientsMatchReviewedSendRules() {
    XCTAssertTrue(EmailDraftReview.validRecipients(to: "ann@example.com, bob+tag@example.org", cc: "cc@example.com"))
    for invalid in ["", "invalid", "Ann <ann@example.com>", "ann@example.com\r\nBcc:bob@example.com"] {
      XCTAssertFalse(EmailDraftReview.validRecipients(to: invalid, cc: ""))
    }
    XCTAssertFalse(EmailDraftReview.validRecipients(to: "ann@example.com", cc: "invalid"))
  }
}
