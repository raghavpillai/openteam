import Foundation
import XCTest

@testable import OpenTeamCore

final class ServerAddressTests: XCTestCase {
  func testAddsTheSchemePeopleLeaveOff() {
    // Same cases as packages/client-core's withDefaultScheme test.
    XCTAssertEqual(API.withDefaultScheme("192.168.1.20:8787"), "http://192.168.1.20:8787")
    XCTAssertEqual(API.withDefaultScheme(" localhost:8787 "), "http://localhost:8787")
    XCTAssertEqual(API.withDefaultScheme("mac-mini.local:8787"), "http://mac-mini.local:8787")
    XCTAssertEqual(API.withDefaultScheme("mac-mini:8787"), "http://mac-mini:8787")
    XCTAssertEqual(API.withDefaultScheme("[::1]:8787"), "http://[::1]:8787")
    XCTAssertEqual(API.withDefaultScheme("openteam.example.com"), "https://openteam.example.com")
    XCTAssertEqual(API.withDefaultScheme("box.tail1234.ts.net"), "https://box.tail1234.ts.net")
    // An explicit port other than 443 is a private, plain-HTTP server (setup's Tailscale address).
    XCTAssertEqual(
      API.withDefaultScheme("box.tail1234.ts.net:8788"), "http://box.tail1234.ts.net:8788")
    XCTAssertEqual(
      API.withDefaultScheme("openteam.example.com:443"), "https://openteam.example.com:443")
    XCTAssertEqual(API.withDefaultScheme("203.0.113.9:8787/"), "http://203.0.113.9:8787/")
    XCTAssertEqual(
      API.withDefaultScheme("openteam.example.com/team"), "https://openteam.example.com/team")
    XCTAssertEqual(API.withDefaultScheme("[::1]"), "http://[::1]")
    XCTAssertEqual(
      API.withDefaultScheme("http://openteam.example.com"), "http://openteam.example.com")
    XCTAssertEqual(API.withDefaultScheme(""), "")
    XCTAssertEqual(API.withDefaultScheme("MAC-MINI.LOCAL/openteam"), "http://MAC-MINI.LOCAL/openteam")
    XCTAssertEqual(API.withDefaultScheme("100.68.177.69"), "http://100.68.177.69")
    XCTAssertEqual(API.withDefaultScheme("HTTPS://openteam.example.com"), "HTTPS://openteam.example.com")
  }
  func testNormalizesBareAddressesAndKeepsValidation() throws {
    XCTAssertEqual(
      try API.normalize("192.168.1.20:8787/").absoluteString, "http://192.168.1.20:8787")
    XCTAssertEqual(
      try API.normalize("OpenTeam.Example.com").absoluteString, "https://openteam.example.com")
    XCTAssertEqual(try API.normalize("mac-mini:8787").absoluteString, "http://mac-mini:8787")
    XCTAssertEqual(
      try API.normalize("raghav-agent-testing.tail658346.ts.net:8788").absoluteString,
      "http://raghav-agent-testing.tail658346.ts.net:8788")
    XCTAssertThrowsError(try API.normalize("not a URL")) { error in
      XCTAssertTrue((error as? APIError)?.message.contains("such as 192.168.1.20:8787") == true)
    }
    XCTAssertThrowsError(try API.normalize("ftp://openteam.example.com"))
    XCTAssertThrowsError(try API.normalize("user:secret@openteam.example.com")) { error in
      XCTAssertTrue((error as? APIError)?.message.contains("Remove the username") == true)
    }
    XCTAssertThrowsError(try API.normalize("192.168.1.20:8787?token=x"))
  }
}

final class InferenceSettingsTests: XCTestCase {
  func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }
  let settingsJSON = #"""
    {"inference":{"providerId":"openai-codex","modelId":"","reasoning":"medium"},
     "providers":[
       {"id":"openai-codex","name":"ChatGPT Plus/Pro (Codex Subscription)","authMethods":[{"type":"oauth","label":"ChatGPT","subscription":true}],"connected":false,"authType":null,"authSource":null,"custom":false,"modelCount":0,"modelStatus":"disconnected","modelMessage":"Sign in to load models."},
       {"id":"anthropic","name":"Anthropic","authMethods":[{"type":"api_key","label":"API key","subscription":false},{"type":"oauth","label":"Claude Pro/Max","subscription":true}],"connected":true,"authType":"api_key","authSource":"environment","custom":false,"modelCount":2},
       {"id":"groq","name":"Groq","authMethods":[{"type":"api_key","label":"API key","subscription":false}],"connected":false,"authType":null,"authSource":null,"custom":false,"modelCount":0}
     ],
     "models":[
       {"providerId":"openai-codex","modelId":"gpt-5.5","name":"GPT-5.5","reasoning":true,"reasoningLevels":["low","medium","high","xhigh"],"defaultReasoningLevel":"medium","contextWindow":400000,"maxTokens":128000},
       {"providerId":"openai-codex","modelId":"gpt-5.5-mini","name":"GPT-5.5 mini","reasoning":false,"reasoningLevels":["off"],"defaultReasoningLevel":"off","contextWindow":400000,"maxTokens":128000}
     ],
     "modelProviderId":"openai-codex"}
    """#
  func testDecodesServerSettingsAndDescribesConnections() throws {
    let settings = try decode(ServerSettings.self, settingsJSON)
    XCTAssertNil(settings.savedModel)
    XCTAssertEqual(settings.providers.map(\.id), ["openai-codex", "anthropic", "groq"])
    XCTAssertEqual(settings.provider("openai-codex")?.modelMessage, "Sign in to load models.")
    XCTAssertEqual(settings.provider("openai-codex")?.connectionSummary, "Not connected.")
    XCTAssertEqual(
      settings.provider("anthropic")?.connectionSummary,
      "Connected with an API key from environment.")
    XCTAssertEqual(settings.provider("anthropic")?.authMethods.map(\.actionTitle), ["Add API key", "Sign in"])
    XCTAssertEqual(settings.models.first?.reasoningLevels, ["low", "medium", "high", "xhigh"])
    // Featured providers use friendly names; the rest keep the server's.
    XCTAssertEqual(ModelSetupCatalog.name("openai-codex", in: settings), "ChatGPT")
    XCTAssertEqual(ModelSetupCatalog.name("groq", in: settings), "Groq")
    XCTAssertEqual(ModelSetupCatalog.others(settings.providers).map(\.id), ["groq"])
    XCTAssertEqual(
      ModelSetupCatalog.featured.map(\.id),
      ["openai-codex", "claude-code", "openai", "anthropic", "openrouter"])
  }
  func testProviderFailuresKeepTheirReasonAndSayWhetherToRetry() {
    // A rejected key, in the provider's own words, is the reason; waiting won't fix it.
    for raw in ["Incorrect API key provided: sk-proj-****abcd.", "403 Forbidden"] {
      let failure = ProviderErrorText.failure(raw)
      XCTAssertEqual(
        failure.message,
        "The AI provider didn't accept the sign-in or key. Sign in again, or choose a different AI.",
        raw)
      XCTAssertFalse(failure.transient, raw)
    }
    // A rate limit passes by waiting; an empty account doesn't, though both can be a 429.
    let limited = ProviderErrorText.failure(
      "429 Rate limit reached for gpt-6.1 in organization org-x on tokens per min.")
    XCTAssertEqual(
      limited.message,
      "The AI provider is limiting requests right now. Wait a moment and try again.")
    XCTAssertTrue(limited.transient)
    for raw in [
      "429 You exceeded your current quota, please check your plan and billing details.",
      "402 Payment Required",
    ] {
      let failure = ProviderErrorText.failure(raw)
      XCTAssertEqual(
        failure.message,
        "Your AI provider account is out of credit or over its limit. Check its plan and billing, or choose a different AI.",
        raw)
      XCTAssertFalse(failure.transient, raw)
    }
    // Blips are worth another try.
    for raw in ["503 Service Unavailable", "The operation timed out.", "read ECONNRESET"] {
      XCTAssertTrue(ProviderErrorText.failure(raw).transient, raw)
    }
    XCTAssertFalse(ProviderErrorText.failure("404 model not found").transient)
    XCTAssertFalse(ProviderErrorText.failure("Your plan has run out.").transient)
  }
  func testChoosesTheFirstModelUntilOneIsSavedAndTracksChanges() throws {
    var settings = try decode(ServerSettings.self, settingsJSON)
    var choice = ModelChoice(loading: settings, provider: "openai-codex")
    XCTAssertEqual(choice, ModelChoice(providerId: "openai-codex", modelId: "gpt-5.5", reasoning: "medium"))
    XCTAssertTrue(choice.changed(from: settings.inference, model: settings.models[0]))
    // A model without the chosen level falls back to its default.
    choice.select(model: settings.models[1])
    XCTAssertEqual(choice.reasoning, "off")
    choice.reasoning = "high"
    XCTAssertEqual(choice.effectiveReasoning(settings.models[1]), "off")
    XCTAssertEqual(choice.effectiveReasoning(nil), "off")
    // Once saved, loading shows the saved choice with its reasoning.
    settings.inference = .init(providerId: "openai-codex", modelId: "gpt-5.5", reasoning: "high")
    choice = ModelChoice(loading: settings)
    XCTAssertEqual(choice.reasoning, "high")
    XCTAssertFalse(choice.changed(from: settings.inference, model: settings.models[0]))
    XCTAssertEqual(
      try JSON.encode(choice.body(model: settings.models[0])),
      .object([
        "providerId": .string("openai-codex"), "modelId": .string("gpt-5.5"),
        "reasoning": .string("high"),
      ]))
  }
  func testProviderManagedReasoningUsesTheDefaultSentinel() throws {
    let model = InferenceModel(
      providerId: "openrouter", modelId: "author/managed", name: "Managed",
      reasoning: true, reasoningLevels: [], defaultReasoningLevel: "off",
      contextWindow: 128000, maxTokens: 8192)
    var choice = ModelChoice(providerId: "openrouter", modelId: model.modelId, reasoning: "max")
    choice.select(model: model)
    XCTAssertEqual(choice.reasoning, "off")
    XCTAssertEqual(choice.effectiveReasoning(model), "off")
    XCTAssertEqual(try JSON.encode(choice.body(model: model)), .object([
      "providerId": .string("openrouter"), "modelId": .string("author/managed"),
      "reasoning": .string("off"),
    ]))
  }

  func testAnswersTheBrowserOrCodeChoiceWithTheCode() throws {
    let select = try decode(
      InferenceAuthSession.self,
      #"{"id":"s1","providerId":"openai-codex","authType":"oauth","status":"waiting","prompt":{"id":"p1","type":"select","message":"How do you want to sign in?","options":[{"id":"browser","label":"Browser"},{"id":"device_code","label":"Device code"}]},"authorizationUrl":null,"deviceCode":null,"messages":[],"error":null}"#
    )
    XCTAssertEqual(select.automaticAnswer?.promptId, "p1")
    XCTAssertEqual(select.automaticAnswer?.value, "device_code")
    XCTAssertNil(select.capturableRedirect)
    var other = select
    other.prompt?.options = [.init(id: "a", label: "A"), .init(id: "b", label: "B")]
    XCTAssertNil(other.automaticAnswer, "Other choices are left to the person")
    let code = try decode(
      InferenceAuthSession.self,
      #"{"id":"s1","providerId":"openai-codex","authType":"oauth","status":"running","prompt":null,"authorizationUrl":null,"deviceCode":{"userCode":"ABCD-1234","verificationUri":"https://auth.openai.com/codex/device","expiresInSeconds":900},"messages":["Waiting"],"error":null}"#
    )
    XCTAssertEqual(code.deviceCode?.userCode, "ABCD-1234")
    XCTAssertFalse(code.finished)
    XCTAssertNil(code.automaticAnswer)
  }
  func testRecognizesTheLocalhostRedirectThatEndsABrowserSignIn() throws {
    let session = try decode(
      InferenceAuthSession.self,
      #"{"id":"s2","providerId":"claude-code","authType":"oauth","status":"waiting","prompt":{"id":"p2","type":"manual_code","message":"Paste the authorization code","placeholder":"http://localhost:53692/callback"},"authorizationUrl":"https://claude.ai/oauth/authorize?state=abc","deviceCode":null,"messages":[],"error":null}"#
    )
    let redirect = try XCTUnwrap(session.capturableRedirect)
    XCTAssertTrue(
      ProviderRedirect.matches(
        URL(string: "http://localhost:53692/callback?code=xyz&state=abc")!, redirect: redirect))
    XCTAssertTrue(
      ProviderRedirect.matches(
        URL(string: "http://127.0.0.1:53692/callback?error=access_denied")!, redirect: redirect))
    for other in [
      "http://localhost:53692/callback",  // No code yet.
      "http://localhost:53693/callback?code=x",  // Another port.
      "http://localhost:53692/other?code=x",  // Another path.
      "https://localhost:53692/callback?code=x",  // Not the plain-HTTP redirect.
      "https://claude.ai/callback?code=x",
    ] {
      XCTAssertFalse(ProviderRedirect.matches(URL(string: other)!, redirect: redirect), other)
    }
    XCTAssertNotNil(ProviderRedirect.local("http://127.0.0.1:3000/oauth/callback"))
    XCTAssertNil(ProviderRedirect.local("https://localhost:53692/callback"))
    XCTAssertNil(ProviderRedirect.local("http://example.com/callback"))
    XCTAssertNil(ProviderRedirect.local("Paste the code"))
    XCTAssertNil(ProviderRedirect.local(nil))
    var finished = session
    finished.status = "connected"
    XCTAssertNil(finished.capturableRedirect)
    var noBrowser = session
    noBrowser.authorizationUrl = nil
    XCTAssertNil(noBrowser.capturableRedirect)
  }
}

final class ServerSetupTests: XCTestCase {
  func testTranscriptionDraftKeepsReplacesOrRemovesTheKey() throws {
    let saved = try JSONDecoder().decode(
      TranscriptionSettingsView.self,
      from: Data(
        #"{"enabled":true,"provider":"openai","baseUrl":"https://api.openai.com/v1","model":"gpt-transcribe","language":"","hasApiKey":true,"apiKeySuffix":"A7z9","configured":true,"apiKey":"unexpected-private-key"}"#
          .utf8))
    XCTAssertEqual(saved.summary, "OpenAI")
    XCTAssertEqual(saved.apiKeySuffix, "A7z9")
    XCTAssertFalse(String(describing: saved).contains("unexpected-private-key"))
    var draft = TranscriptionDraft(saved)
    XCTAssertFalse(draft.changed(from: saved))
    XCTAssertTrue(draft.hasSavedKey(saved))
    // Omitting apiKey keeps the saved key; a blank entry is not a replacement.
    XCTAssertNil(draft.body.object["apiKey"])
    draft.apiKey = "   "
    XCTAssertFalse(draft.changed(from: saved))
    XCTAssertNil(draft.body.object["apiKey"])
    draft.apiKey = " sk-new "
    XCTAssertTrue(draft.changed(from: saved))
    XCTAssertEqual(draft.body["apiKey"], .string("sk-new"))
    draft.apiKey = ""
    draft.removeKey = true
    XCTAssertFalse(draft.hasSavedKey(saved))
    XCTAssertEqual(draft.body["apiKey"], .null)
    // Another provider resets the address and model, and the saved key no longer applies.
    draft.choose(.deepgram)
    XCTAssertEqual(draft.settings.baseUrl, "https://api.deepgram.com/v1")
    XCTAssertEqual(draft.settings.model, "nova-3")
    XCTAssertFalse(draft.removeKey)
    XCTAssertFalse(draft.hasSavedKey(saved))
    draft.choose(.compatible)
    XCTAssertEqual(draft.settings.baseUrl, "")
    XCTAssertEqual(draft.body["provider"], .string("openai-compatible"))
    XCTAssertTrue(TranscriptionDraft(nil).changed(from: nil))
    // A server that was never set up opens on OpenAI with its default model, as on desktop.
    let untouched = try JSONDecoder().decode(
      TranscriptionSettingsView.self,
      from: Data(
        #"{"enabled":false,"provider":"openai-compatible","baseUrl":"","model":"","language":"","hasApiKey":false,"configured":false}"#
          .utf8))
    XCTAssertTrue(untouched.untouched)
    let fresh = TranscriptionDraft(untouched)
    XCTAssertEqual(fresh.settings.provider, .openai)
    XCTAssertEqual(fresh.settings.baseUrl, "https://api.openai.com/v1")
    XCTAssertEqual(fresh.settings.model, "gpt-transcribe")
    XCTAssertFalse(fresh.settings.enabled)
    // A custom service someone saved stays as it is.
    var custom = untouched
    custom.settings.baseUrl = "http://audio:8000/v1"
    XCTAssertEqual(TranscriptionDraft(custom).settings.provider, .compatible)
    XCTAssertEqual(
      TranscriptionRequest.savedMessage(saved), "Saved. Voice notes are enabled on connected devices.")
    var off = saved
    off.settings.enabled = false
    XCTAssertEqual(off.summary, "Off")
  }
}
