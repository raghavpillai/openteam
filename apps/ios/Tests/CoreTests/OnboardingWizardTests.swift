import Foundation
import XCTest

@testable import OpenTeamCore

final class OnboardingWizardTests: XCTestCase {
  func testStagesAndSteps() {
    XCTAssertEqual(WizardStage.allCases.map(\.title), ["Server", "AI model", "Web search", "Voice", "First bot"])
    XCTAssertEqual(WizardStep.health.stage, .server)
    XCTAssertEqual(
      [WizardStep.choose, .method, .signIn, .apiKey, .test].map(\.stage),
      [.model, .model, .model, .model, .model])
    XCTAssertEqual(WizardStep.search.stage, .search)
    XCTAssertEqual(WizardStep.voice.stage, .voice)
    XCTAssertEqual(WizardStep.bot.stage, .bot)
    XCTAssertEqual(WizardStep.afterModel(searchConfigured: false, voiceConfigured: true), .search)
    XCTAssertEqual(WizardStep.afterModel(searchConfigured: true, voiceConfigured: false), .voice)
    XCTAssertEqual(WizardStep.afterModel(searchConfigured: true, voiceConfigured: true), .bot)
    XCTAssertEqual(WizardStep.afterSearch(voiceConfigured: false), .voice)
  }

  func testGuessesTheProviderFromTheKeyPrefix() {
    XCTAssertEqual(APIKeyProviders.guess("sk-ant-api03-abc"), "anthropic")
    XCTAssertEqual(APIKeyProviders.guess("  sk-or-v1-abc "), "openrouter")
    XCTAssertEqual(APIKeyProviders.guess("sk-proj-abc"), "openai")
    XCTAssertEqual(APIKeyProviders.guess("sk-abc"), "openai")
    XCTAssertEqual(APIKeyProviders.guess("SK-ANT-abc"), "anthropic")
    XCTAssertNil(APIKeyProviders.guess("gsk_abc"))
    XCTAssertNil(APIKeyProviders.guess(""))
    XCTAssertEqual(APIKeyProviders.options.map(\.id), ["openai", "anthropic", "openrouter"])
    XCTAssertEqual(
      APIKeyProviders.options.map(\.keyPage.absoluteString),
      [
        "https://platform.openai.com/api-keys", "https://console.anthropic.com/settings/keys",
        "https://openrouter.ai/keys",
      ])
  }

  func testFirstBotDefaultsAndRequest() throws {
    XCTAssertEqual(FirstBot.names, ["Atlas", "Nova", "Juniper", "Pixel", "Sage", "Orbit"])
    XCTAssertEqual(
      FirstBot.roles.map(\.title),
      ["General helper", "Researcher", "Inbox assistant", "Writer", "Operations"])
    XCTAssertEqual(
      FirstBot.roles.first?.description,
      "Helps with research, writing, and everyday tasks on the web.")
    XCTAssertEqual(
      FirstBot.greeting(name: " Nova ", role: FirstBot.roles[2]),
      "Hi, I'm Nova! I sort email, draft replies for your review, and track follow-ups. What should we start with?"
    )
    XCTAssertTrue(FirstBot.greeting(name: "", role: FirstBot.roles[0]).hasPrefix("Hi! I can help"))
    XCTAssertTrue(FirstBot.names.contains(FirstBot.randomName()))
    XCTAssertEqual(FirstBot.randomName(excluding: ["atlas", "Nova", "Juniper", "Pixel", "Sage"]), "Orbit")
    // The palette leaves out near-black and grey, and every color is a valid bot color.
    XCTAssertFalse(FirstBot.colors.isEmpty)
    for color in FirstBot.colors {
      XCTAssertNotNil(color.range(of: #"^#[0-9a-fA-F]{6}$"#, options: .regularExpression), color)
      XCTAssertFalse(["#242424", "#878787"].contains(color))
    }
    var previous = FirstBot.randomAvatar()
    for _ in 0..<50 {
      let next = FirstBot.randomAvatar(excluding: previous)
      XCTAssertNotNil(RobotShape(rawValue: next.shape))
      XCTAssertNotEqual(next.shape, previous.shape)
      XCTAssertNotEqual(next.color, previous.color)
      previous = next
    }
    let role = try XCTUnwrap(FirstBot.roles.first { $0.id == "inbox" })
    let body = FirstBot.body(
      requestId: "request-1234", name: "  Nova ", avatar: .init(shape: "tv-head", color: "#4B8EFB"),
      role: role)
    XCTAssertEqual(
      body,
      .object([
        "clientRequestId": .string("request-1234"), "name": .string("Nova"),
        "icon": .string("tv-head"), "color": .string("#4b8efb"),
        "description": .string(
          "Sorts email, drafts replies for your review, and tracks follow-ups."),
      ]))
    XCTAssertEqual(
      FirstBot.body(requestId: "request-1234", name: " ", avatar: previous, role: role)["name"]
        .string, "New Bot")
  }

  func testServerAddressText() {
    XCTAssertEqual(ServerAddressText.authority("192.168.1.20:8787"), "192.168.1.20:8787")
    XCTAssertEqual(
      ServerAddressText.authority("raghav-agent-testing.tail658346.ts.net:8788"),
      "raghav-agent-testing.tail658346.ts.net:8788")
    XCTAssertEqual(ServerAddressText.authority("https://openteam.example.com/"), "openteam.example.com")
    XCTAssertEqual(ServerAddressText.authority(" not a URL "), "not a URL")
    XCTAssertEqual(ServerAddressText.host("http://192.168.1.20:8787"), "192.168.1.20")
    XCTAssertEqual(ServerAddressText.host("box.tail1234.ts.net:8788"), "box.tail1234.ts.net")
    XCTAssertEqual(ServerAddressText.found(version: "0.0.5"), "Found OpenTeam 0.0.5")
    XCTAssertEqual(ServerAddressText.found(version: nil), "Found OpenTeam")
  }

  func testChatGPTAndClaudeOfferThePlanOrAKey() {
    XCTAssertEqual(ProviderFamilies.all.map(\.title), ["ChatGPT", "Claude"])
    let chatgpt = ProviderFamilies.chatgpt.methods
    XCTAssertEqual(chatgpt.map(\.providerId), ["openai-codex", "openai"])
    XCTAssertEqual(chatgpt.map(\.authType), ["oauth", "api_key"])
    XCTAssertEqual(chatgpt.map(\.title), ["Sign in with ChatGPT", "Use an OpenAI API key"])
    XCTAssertEqual(chatgpt[0].detail, "Uses your ChatGPT Plus or Pro plan")
    XCTAssertEqual(chatgpt[1].detail, "Pay per use with a key from platform.openai.com")
    let claude = ProviderFamilies.claude.methods
    XCTAssertEqual(claude.map(\.providerId), ["claude-code", "anthropic"])
    XCTAssertEqual(claude.map(\.title), ["Sign in with Claude", "Use an Anthropic API key"])
    XCTAssertEqual(ProviderFamilies.family(of: "anthropic")?.id, "claude")
    XCTAssertEqual(ProviderFamilies.family(of: "openai-codex")?.id, "chatgpt")
    XCTAssertNil(ProviderFamilies.family(of: "openrouter"))
    // Every method is a featured provider, so "More providers" never repeats one.
    let featured = Set(ModelSetupCatalog.featured.map(\.id))
    XCTAssertTrue(ProviderFamilies.all.flatMap(\.methods).allSatisfy { featured.contains($0.providerId) })
  }

  func testTellsABotFromThisCreateFromOneMadeElsewhere() throws {
    func bot(_ id: String, _ name: String, icon: String = "chip", color: String = "#4B8EFB") throws
      -> Bot
    {
      try JSONDecoder().decode(
        Bot.self,
        from: Data(
          """
          {"id":"\(id)","name":"\(name)","title":"","description":"","instructions":"",
           "icon":"\(icon)","color":"\(color)","hasAvatar":false,"notificationsEnabled":true,
           "hiddenFromSidebar":false,"status":"ready","conversationId":"c-\(id)",
           "dmChannelId":"dm-\(id)"}
          """.utf8))
    }
    let role = FirstBot.roles[1]
    let sent = FirstBot.Request(
      body: FirstBot.body(
        requestId: "request-1234", name: " Juniper ",
        avatar: .init(shape: "chip", color: "#4b8efb"), role: role))
    let older = try bot("old", "Atlas")
    let mine = try bot("mine", "Juniper")
    let theirs = try bot("theirs", "Juniper", icon: "pod")

    // Nothing new: no arrival, whatever was sent.
    XCTAssertNil(FirstBot.arrival(bots: [older], existing: ["old"], sent: [sent]))
    // Our Create landed though its answer was lost: same name, shape and color.
    XCTAssertEqual(
      FirstBot.arrival(bots: [older, mine], existing: ["old"], sent: [sent]), .ours(mine))
    // A bot no Create from here asked for came from another device.
    XCTAssertEqual(FirstBot.arrival(bots: [theirs], existing: [], sent: [sent]), .elsewhere(theirs))
    XCTAssertEqual(FirstBot.arrival(bots: [mine], existing: [], sent: []), .elsewhere(mine))
    // Ours wins over one from elsewhere, and set-aside bots are ignored.
    XCTAssertEqual(FirstBot.arrival(bots: [mine, theirs], existing: [], sent: [sent]), .ours(mine))
    XCTAssertNil(FirstBot.arrival(bots: [theirs], existing: [], sent: [sent], ignoring: ["theirs"]))
    XCTAssertEqual(FirstBot.Arrival.elsewhere(theirs).bot, theirs)
  }

  func testReplySentence() {
    XCTAssertEqual(
      ModelTestState.passed(latencyMs: 1234).replySentence(model: "GPT-5.5"),
      "GPT-5.5 replied in 1.2 s.")
    XCTAssertNil(ModelTestState.running.replySentence(model: "GPT-5.5"))
    XCTAssertNil(ModelTestState.failed("No").replySentence(model: "GPT-5.5"))
  }
}
