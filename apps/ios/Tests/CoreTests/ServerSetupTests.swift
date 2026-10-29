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
  func testProviderFailuresReadAsSentences() {
    XCTAssertEqual(
      ProviderErrorText.sentence(#"500 {"error":{"message":"boom","type":"server_error"}}"#),
      "The AI provider had a problem (error 500). Try again in a moment.")
    XCTAssertEqual(
      ProviderErrorText.sentence("Error 429: rate limit reached"),
      "The AI provider is limiting requests right now. Wait a moment and try again.")
    XCTAssertEqual(
      ProviderErrorText.sentence("401 Unauthorized"),
      "The AI provider didn't accept the sign-in or key. Sign in again, or choose a different AI.")
    XCTAssertEqual(
      ProviderErrorText.sentence("The operation was aborted due to timeout"),
      "The AI took too long to answer. Try again.")
    XCTAssertEqual(
      ProviderErrorText.sentence("OpenTeamClientError: fetch failed"),
      "Your server couldn't reach the AI right now. Check its internet connection and try again.")
    XCTAssertEqual(
      ProviderErrorText.sentence("TypeError: The model is overloaded."),
      "The AI provider is overloaded right now. Try again in a moment.")
    XCTAssertEqual(
      ProviderErrorText.sentence("Inference provider rejected the configuration or request"),
      "The AI provider didn't accept a request to this model. Choose a different model or reasoning effort.")
    XCTAssertEqual(ProviderErrorText.sentence(#"{"error":"x"}"#), "The AI didn't reply. Try again.")
    // A readable message passes through, and the test state uses the sentence.
    XCTAssertEqual(ProviderErrorText.sentence("Your plan has run out."), "Your plan has run out.")
    XCTAssertEqual(
      ProviderErrorText.sentence("Error: No API key found for openai."), "No API key found for openai.")
    XCTAssertEqual(
      ModelTestState(.failed(error: "503 Service Unavailable")),
      .failed("The AI provider had a problem (error 503). Try again in a moment."))
  }
  func testProviderFailuresKeepTheirReasonAndSayWhetherToRetry() {
    // A rejected key, in the provider's own words, is the reason; waiting won't fix it.
    for raw in [
      "Incorrect API key provided: sk-proj-****abcd.", "invalid x-api-key",
      #"{"type":"error","error":{"type":"authentication_error"}}"#, "403 Forbidden",
    ] {
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
      "Your credit balance is too low to access the Anthropic API.", "402 Payment Required",
    ] {
      let failure = ProviderErrorText.failure(raw)
      XCTAssertEqual(
        failure.message,
        "Your AI provider account is out of credit or over its limit. Check its plan and billing, or choose a different AI.",
        raw)
      XCTAssertFalse(failure.transient, raw)
    }
    // Blips are worth another try.
    for raw in [
      "503 Service Unavailable", "529 overloaded_error", "The operation timed out.", "fetch failed",
      "read ECONNRESET", "504 Gateway Timeout",
    ] {
      XCTAssertTrue(ProviderErrorText.failure(raw).transient, raw)
    }
    XCTAssertFalse(ProviderErrorText.failure("404 model not found").transient)
    XCTAssertFalse(ProviderErrorText.failure("Your plan has run out.").transient)
  }
  func testTheKeyStepNamesTheProviderThatTurnedTheKeyDown() {
    // The computer's discovery error, a provider's own words, and a 401 from the test.
    for raw in [
      "The provider rejected model discovery (HTTP 401). Reconnect it or grant model-list access.",
      "Incorrect API key provided.",
      "401 Incorrect API key provided: sk-bad****.",
    ] {
      let failure = ProviderErrorText.failure(raw)
      XCTAssertTrue(failure.rejected, raw)
      XCTAssertEqual(
        failure.keyMessage(provider: "OpenAI"), "OpenAI didn't accept that key. Check it and try again.")
    }
    // Anything else keeps its own sentence on the key step.
    let busy = ProviderErrorText.failure("503 Service Unavailable")
    XCTAssertFalse(busy.rejected)
    XCTAssertEqual(
      busy.keyMessage(provider: "Anthropic"),
      "The AI provider had a problem (error 503). Try again in a moment.")
    XCTAssertFalse(ProviderErrorText.failure("429 You exceeded your current quota.").rejected)
    XCTAssertFalse(ModelTestFailure(request: URLError(.timedOut)).rejected)
  }
  func testTestRequestFailuresReadAsSentences() {
    func failure(_ error: Error) -> ModelTestFailure { ModelTestFailure(request: error) }
    XCTAssertEqual(
      failure(URLError(.timedOut)),
      ModelTestFailure(message: "Your server didn't answer in time. Try again.", transient: true))
    for code in [URLError.Code.networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost] {
      XCTAssertEqual(
        failure(URLError(code)),
        ModelTestFailure(
          message: "Couldn't reach your server. Check your connection and try again.",
          transient: true))
    }
    XCTAssertFalse(failure(URLError(.serverCertificateUntrusted)).transient)
    // The server's own statuses: busy, failing or slow is a blip, and its raw body isn't shown.
    XCTAssertEqual(
      failure(APIError("Injected 503 by the chaos proxy", status: 503)),
      ModelTestFailure(
        message: "Your server had a problem (error 503). Try again in a moment.", transient: true))
    XCTAssertEqual(
      failure(APIError("Too many requests. Please try again later.", status: 429)),
      ModelTestFailure(
        message: "Your server is busy right now. Wait a moment and try again.", transient: true))
    XCTAssertEqual(
      failure(APIError("Gateway Timeout", status: 504)).message,
      "Your server didn't answer in time. Try again.")
    // An answer cut off halfway can't be read, and is worth another try.
    XCTAssertEqual(
      failure(APIError("The server returned an invalid response.")),
      ModelTestFailure(
        message: "Your server's answer didn't come through. Try again.", transient: true))
    // A meaningful answer from the server is kept, without a class name.
    XCTAssertEqual(
      failure(APIError("Choose a model before testing it.", status: 409)),
      ModelTestFailure(message: "Choose a model before testing it.", transient: false))
    XCTAssertEqual(
      failure(APIError("OpenTeamClientError: Unknown provider", status: 400)).message,
      "Unknown provider")
    XCTAssertFalse(
      failure(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "x"))).transient)
  }
  func testStartsOnTheRecommendedModelWhenTheCatalogMarksOne() throws {
    let json = #"""
      {"inference":{"providerId":"openai-codex","modelId":"","reasoning":"medium"},
       "providers":[{"id":"openrouter","name":"OpenRouter","authMethods":[{"type":"api_key","label":"API key","subscription":false}],"connected":true,"authType":"api_key","authSource":null,"custom":false,"modelCount":2}],
       "models":[
         {"providerId":"openrouter","modelId":"anthropic/claude-sonnet-4.5","name":"Anthropic: Claude Sonnet 4.5","reasoning":true,"reasoningLevels":["low","medium","high"],"defaultReasoningLevel":"medium","contextWindow":200000,"maxTokens":64000},
         {"providerId":"openrouter","modelId":"openrouter/auto","name":"Auto Router","reasoning":false,"reasoningLevels":["off"],"defaultReasoningLevel":"off","contextWindow":2000000,"maxTokens":128000,"recommended":true}
       ],
       "modelProviderId":"openrouter"}
      """#
    let settings = try decode(ServerSettings.self, json)
    XCTAssertEqual(settings.models.map(\.recommended), [false, true])
    XCTAssertEqual(settings.recommendedModel?.modelId, "openrouter/auto")
    XCTAssertEqual(ModelChoice(loading: settings, provider: "openrouter").modelId, "openrouter/auto")
    // Without a recommendation, the catalog's first model.
    let plain = try decode(ServerSettings.self, settingsJSON)
    XCTAssertFalse(plain.models.contains(where: \.recommended))
    XCTAssertEqual(plain.recommendedModel?.modelId, "gpt-5.5")
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
  func testDecodesModelTestsAndDescribesThem() throws {
    let passed = try decode(
      InferenceTestResult.self,
      #"{"ok":true,"providerId":"openai-codex","modelId":"gpt-5.5","latencyMs":1234}"#)
    XCTAssertEqual(passed, .passed(latencyMs: 1234))
    XCTAssertEqual(ModelTestState(passed).text, "Working · replied in 1.2 s")
    let failed = try decode(
      InferenceTestResult.self,
      #"{"ok":false,"providerId":"openai","modelId":"gpt-5","error":"Incorrect API key provided."}"#)
    XCTAssertEqual(
      ModelTestState(failed),
      .failed(
        "The AI provider didn't accept the sign-in or key. Sign in again, or choose a different AI."))
    XCTAssertEqual(ModelTestState.running.text, "Testing the model…")
    XCTAssertNil(ModelTestState.idle.text)
    XCTAssertEqual(ModelSetupCatalog.reasoningLabel("xhigh"), "Extra high")
    XCTAssertEqual(ModelSetupCatalog.reasoningLabel("off"), "Off")
    XCTAssertEqual(ModelSetupCatalog.reasoningLabel("minimal"), "Minimal")
  }
  func testRequestPathsAndBodies() {
    XCTAssertEqual(
      InferenceRequest.startPath("openai-codex"),
      "/api/v0/inference-providers/openai-codex/auth-sessions")
    XCTAssertEqual(
      InferenceRequest.respondPath("a b"), "/api/v0/inference-provider-auth-sessions/a%20b/respond")
    XCTAssertEqual(
      InferenceRequest.respond(promptId: "p", value: "v"),
      .object(["promptId": .string("p"), "value": .string("v")]))
    XCTAssertEqual(InferenceRequest.start(authType: "api_key"), .object(["authType": .string("api_key")]))
  }
}

final class ServerSetupTests: XCTestCase {
  func testTranscriptionDraftKeepsReplacesOrRemovesTheKey() throws {
    let saved = try JSONDecoder().decode(
      TranscriptionSettingsView.self,
      from: Data(
        #"{"enabled":true,"provider":"openai","baseUrl":"https://api.openai.com/v1","model":"gpt-transcribe","language":"","hasApiKey":true,"configured":true}"#
          .utf8))
    XCTAssertEqual(saved.summary, "OpenAI")
    var draft = TranscriptionDraft(saved)
    XCTAssertFalse(draft.changed(from: saved))
    XCTAssertTrue(draft.hasSavedKey(saved))
    // Omitting apiKey keeps the saved key.
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
    XCTAssertEqual(
      TranscriptionRequest.savedMessage(saved), "Saved. Voice notes are enabled on connected devices.")
    var off = saved
    off.settings.enabled = false
    XCTAssertEqual(off.summary, "Off")
  }
  func testRuntimeChecksBannerAndOnboarding() throws {
    let runtime = RuntimeStatus(
      try JSONDecoder().decode(
        JSON.self,
        from: Data(
          #"{"server":"degraded","database":"ready","queue":"unavailable","computer":"ready","inference":"missing","transcription":"configured"}"#
            .utf8)))
    XCTAssertFalse(runtime.serverReady)
    XCTAssertEqual(runtime.serverChecks.map(\.label), ["Server", "Database", "Task queue", "Bot computer"])
    // "degraded" is the server's overall status; it answered, so only the queue fails.
    XCTAssertEqual(runtime.serverChecks.filter { !$0.ready }.map(\.key), ["queue"])
    XCTAssertEqual(
      RuntimeStatus(values: ["server": "degraded", "database": "ready", "queue": "ready", "computer": "unavailable"])
        .serverChecks.filter { !$0.ready }.map(\.key), ["computer"])
    XCTAssertTrue(
      RuntimeStatus(values: ["server": "ready", "database": "ready", "queue": "ready", "computer": "ready"])
        .serverReady)
    XCTAssertFalse(RuntimeStatus(values: [:]).serverChecks[0].ready, "No snapshot, no answer")
    XCTAssertEqual(runtime.statusRows.map(\.label), ["Server", "Database", "Task queue", "Bot computer", "Model", "Voice notes"])
    XCTAssertEqual(runtime.statusRows[4].value, "Not set up")
    XCTAssertEqual(
      ModelStatusBanner(inference: "missing")?.message,
      "No model is connected, so your bots can't reply yet.")
    XCTAssertEqual(ModelStatusBanner(inference: "invalid")?.action, "Connect a model")
    XCTAssertEqual(ModelStatusBanner(inference: "unavailable")?.action, "Open settings")
    XCTAssertNil(ModelStatusBanner(inference: "ready"))
    XCTAssertNil(ModelStatusBanner(inference: nil), "Nothing to show before the server answers")
    XCTAssertTrue(OnboardingDecision.needed(bots: 0, runtime: RuntimeStatus(values: ["inference": "ready"])))
    XCTAssertTrue(OnboardingDecision.needed(bots: 3, runtime: runtime))
    XCTAssertFalse(OnboardingDecision.needed(bots: 3, runtime: RuntimeStatus(values: ["inference": "invalid"])))
    XCTAssertFalse(OnboardingDecision.needed(bots: 1, runtime: RuntimeStatus(values: [:])))
  }
}
