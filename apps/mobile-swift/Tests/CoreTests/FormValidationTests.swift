import Foundation
import XCTest

@testable import OpenTeamCore

final class FormValidationTests: XCTestCase {
  func json(_ value: String) throws -> JSON {
    try JSONDecoder().decode(JSON.self, from: Data(value.utf8))
  }
  func testPluginValidationPreservesSavedSecretsAndFalseBooleans() throws {
    let fields = try json(
      #"[{"key":"token","label":"API token","secret":true,"required":true},{"key":"enabled","type":"boolean","required":true},{"key":"count","type":"integer"},{"key":"region","enum":["east","west"]}]"#
    ).array
    XCTAssertNoThrow(
      try FormValidation.fields(
        fields, values: ["enabled": .bool(false), "count": .number(3), "region": .string("west")],
        savedSecrets: ["token"]))
    XCTAssertThrowsError(try FormValidation.fields(fields, values: ["enabled": .bool(false)]))
    XCTAssertThrowsError(
      try FormValidation.fields(fields, values: ["count": .number(2.5)], savedSecrets: ["token"]))
    XCTAssertThrowsError(
      try FormValidation.fields(
        fields, values: ["enabled": .bool(false), "region": .string("unknown")],
        savedSecrets: ["token"]))
  }
  func testAdvancedConfigurationRejectsMalformedAndNonStringMaps() throws {
    XCTAssertNoThrow(try FormValidation.stringMap(#"{"X-Custom":"value"}"#, label: "Headers"))
    for invalid in ["{", "[]", #"{"number":1}"#, #"{"nested":{}}"#] {
      XCTAssertThrowsError(try FormValidation.stringMap(invalid, label: "Headers"))
    }
    XCTAssertNoThrow(
      try FormValidation.json(#"["--port","3000"]"#, label: "Arguments", object: false))
    XCTAssertThrowsError(try FormValidation.json("{}", label: "Arguments", object: false))
  }
  func testUserFormRejectsStaleOptionsUnknownKeysAndUncheckedConsent() throws {
    let form = try json(
      #"{"fields":[{"id":"consent","label":"Consent","type":"checkbox","required":true},{"id":"place","label":"Place","type":"select","required":true,"options":[{"value":"NY"}]}]}"#
    )
    XCTAssertNoThrow(
      try FormValidation.userForm(form, values: ["consent": .bool(true), "place": .string("NY")]))
    for values: [String: JSON] in [
      ["consent": .bool(false), "place": .string("NY")],
      ["consent": .string("true"), "place": .string("NY")],
      ["consent": .bool(true), "place": .string("old")],
      ["consent": .bool(true), "place": .string("NY"), "removed": .string("value")],
    ] {
      XCTAssertThrowsError(try FormValidation.userForm(form, values: values))
    }
  }
  func testCompositeAndEventSchedulesCannotBeFlattenedByEditor() throws {
    let base =
      #"{"id":"r","name":"Routine","prompt":"Test","schedule":"0 9 * * *","scheduleKind":"cron","timezone":"UTC","enabled":true,"revision":2}"#
    var value = try json(base)
    XCTAssertTrue(try value.decode(Routine.self).scheduleIsEditable)
    value["schedules"] = .array([.string("0 9 * * *"), .string("0 17 * * *")])
    XCTAssertFalse(try value.decode(Routine.self).scheduleIsEditable)
    value["schedules"] = .null
    value["trigger"] = .object(["type": .string("group")])
    XCTAssertFalse(try value.decode(Routine.self).scheduleIsEditable)
    value["trigger"] = .null
    value["scheduleKind"] = .string("event")
    XCTAssertFalse(try value.decode(Routine.self).scheduleIsEditable)
  }
}
