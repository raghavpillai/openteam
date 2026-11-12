import XCTest

// Apple currently ships SiriEvaluations for physical devices only. Regular UI
// runs must not invoke Siri or modify a connected user's server.
#if canImport(SiriEvaluations) && !targetEnvironment(simulator)
import AppIntentsTesting
import Evaluations
import SiriEvaluations

@available(iOS 27.3, *)
@MainActor
final class SiriSkillsUITests: XCTestCase {
  override func setUpWithError() throws {
    guard ProcessInfo.processInfo.environment["OPENTEAM_LIVE_SIRI_TESTS"] == "1" else {
      throw XCTSkip("Opt-in only: use a development-signed iPhone with Siri AI preview and an isolated QA account")
    }
  }

  private var definitions: IntentDefinitions {
    IntentDefinitions(bundleIdentifier: "dev.openteam.mobile.swift")
  }

  func testServerMessageSearchTool() async throws {
    let find = definitions.intents["FindTeamMessagesIntent"]
    try await evaluate(SiriScenario {
      UserTurn("Find messages in OpenTeam matching deployment") {
        Calls { find.expect(query: .equals("deployment")) }
      }
    })
  }

  func testNamedConversationDraftTool() async throws {
    let draft = definitions.intents["DraftTeamConversationMessageIntent"]
    let conversation = definitions.entities["TeamConversationEntity"].expectIdentifier(try qaConversationID())
    try await evaluate(SiriScenario {
      UserTurn("Draft a message in OpenTeam to the Release review group saying Please review the release") {
        Calls {
          draft.expect(conversation: conversation,
            text: .equals("Please review the release"))
        }
        Calls(.disallowed) {
          definitions.intents["SendTeamConversationMessageIntent"].expect()
          definitions.intents["SendBotTaskIntent"].expect()
          definitions.intents["SendTeamSiriMessage"].expect()
        }
      }
    })
  }

  func testFollowUpKeepsTheDraftInTheSameConversation() async throws {
    let draft = definitions.intents["DraftTeamConversationMessageIntent"]
    let conversation = definitions.entities["TeamConversationEntity"].expectIdentifier(try qaConversationID())
    try await evaluate(SiriScenario {
      UserTurn("Draft a message in OpenTeam to the Release review group saying Please review the release") {
        Calls { draft.expect(conversation: conversation) }
      }
      UserTurn("Also add: check the deployment notes") {
        Calls { draft.expect(conversation: conversation) }
        Calls(.disallowed) {
          definitions.intents["SendTeamConversationMessageIntent"].expect()
          definitions.intents["SendBotTaskIntent"].expect()
          definitions.intents["SendTeamSiriMessage"].expect()
        }
      }
    })
  }

  private func qaConversationID() throws -> String {
    guard let id = ProcessInfo.processInfo.environment["OPENTEAM_SIRI_QA_CONVERSATION_ID"], !id.isEmpty else {
      throw XCTSkip("Supply the scoped entity ID for the isolated Release review QA conversation")
    }
    return id
  }

  private func evaluate(_ scenario: SiriScenario) async throws {
    let subject = try await SiriService.run(scenario: scenario)
    let metrics = try await SiriExpectationEvaluator().metrics(subject: subject, input: scenario)
    let passed = metrics.first { $0.name == Metric.intentsAllPass.name }
    XCTAssertEqual(passed?.doubleValue, 1, passed?.rationale ?? "Siri did not return intent metrics")
  }
}
#endif
