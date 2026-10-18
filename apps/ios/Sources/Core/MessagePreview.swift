import Foundation

/// One line of plain text describing a message, for the conversation list.
/// Mirrors packages/contracts/src/message-preview.ts; Tests/CoreTests/Fixtures/message-previews.json
/// is exported from it by scripts/export-message-previews.ts.
public enum MessagePreview {
  /// Longest preview, in UTF-16 code units, including the trailing ellipsis.
  public static let limit = 200
  private static let markdownScanLimit = 4_096

  /// The first line of a message with visible text, as plain text. Only lines starting within
  /// the first few thousand characters are considered, so a huge message stays cheap.
  public static func text(_ content: String, limit: Int = limit) -> String {
    guard limit == Self.limit else { return uncachedText(content, limit: limit) }
    if let cached = PreviewCache.shared[content] { return cached }
    let text = uncachedText(content, limit: limit)
    PreviewCache.shared[content] = text
    return text
  }

  private static func uncachedText(_ content: String, limit: Int) -> String {
    let head = Array(content.utf16.prefix(2 * markdownScanLimit))
    var start = 0
    while start < min(head.count, markdownScanLimit) {
      let newline = head[start...].firstIndex(of: 0x0A)
      var end = min(newline ?? head.count, start + markdownScanLimit)
      if end > start, (0xD800...0xDBFF).contains(head[end - 1]) { end -= 1 }
      let line = String(decoding: head[start..<end], as: UTF16.self)
      let text = trim(line).isEmpty ? "" : plainText(line)
      if !text.isEmpty { return truncate(text, limit: limit) }
      guard let newline else { break }
      start = newline + 1
    }
    return ""
  }

  /// Markdown as the plain text a reader sees, on one line.
  public static func plainText(_ markdown: String) -> String {
    let stripped = syntax.reduce(stripMathDelimiters(stripFormattingTags(markdown))) {
      text, rule in replace(rule.pattern, in: text, with: rule.template)
    }
    return trim(replace(whitespace, in: stripped, with: " "))
  }

  public static func truncate(_ value: String, limit: Int = limit) -> String {
    guard (value as NSString).length > limit else { return value }
    return trim(prefix(value, limit - 1), leading: false) + "…"
  }

  /// "Sent 1 image", or "Sent 3 files · 2 images, 1 PDF" for a mix.
  public static func attachments(_ assets: [Asset]) -> String {
    var kinds: [String] = []
    var counts: [String: Int] = [:]
    for asset in assets {
      let kind = attachmentKind(mimeType: asset.mimeType, fileName: asset.fileName)
      if counts[kind] == nil { kinds.append(kind) }
      counts[kind, default: 0] += 1
    }
    let total = max(1, assets.count)
    guard kinds.count > 1 else { return "Sent \(counted(kinds.first ?? "file", total))" }
    let breakdown = kinds.map { counted($0, counts[$0] ?? 0) }.joined(separator: ", ")
    return "Sent \(counted("file", total)) · \(breakdown)"
  }

  public static func attachmentKind(mimeType: String?, fileName: String?) -> String {
    if let mimeType, !mimeType.isEmpty, let kind = kind(mimeType: mimeType) { return kind }
    if let fileName, !fileName.isEmpty, let kind = kind(fileName: fileName) { return kind }
    return "file"
  }

  /// JavaScript's `\s`, which is also what `trim()` removes. Foundation's and ICU's whitespace
  /// sets differ from it (U+0085, U+200B, U+FEFF), and previews must match the desktop.
  private static let space =
    "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
  /// JavaScript's multiline `^`: the start of the text or just after LF, CR, U+2028 or U+2029.
  private static let lineStart = "(?<![^\\n\\r\\u2028\\u2029])"

  private static func isSpace(_ unit: UInt16) -> Bool {
    switch unit {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
      0xFEFF:
      true
    default: false
    }
  }

  /// JavaScript's `trim()` (or `trimEnd()`), on UTF-16 code units.
  static func trim(_ value: String, leading: Bool = true) -> String {
    let units = Array(value.utf16)
    var lower = 0
    var upper = units.count
    if leading { while lower < upper, isSpace(units[lower]) { lower += 1 } }
    while upper > lower, isSpace(units[upper - 1]) { upper -= 1 }
    if lower == 0, upper == units.count { return value }
    return String(decoding: units[lower..<upper], as: UTF16.self)
  }

  /// Splits on one UTF-16 code unit. Foundation's `components(separatedBy:)` compares composed
  /// characters, so it would miss a line break followed by a combining mark.
  private static func split(_ value: String, on separator: UInt16) -> [String] {
    value.utf16.split(separator: separator, omittingEmptySubsequences: false).map {
      String(decoding: $0, as: UTF16.self)
    }
  }

  private static func prefix(_ value: String, _ length: Int) -> String {
    let text = value as NSString
    var end = min(length, text.length)
    if end > 0, (0xD800...0xDBFF).contains(text.character(at: end - 1)) { end -= 1 }
    return text.substring(to: end)
  }

  // MARK: Code ranges

  private typealias Range = (start: Int, end: Int)

  private static func inRanges(_ index: Int, _ ranges: [Range]) -> Bool {
    ranges.contains { index >= $0.start && index < $0.end }
  }

  private static let fenceLine = regex("^[ \\t]*(`{3,}|~{3,})")

  private static func fencedCodeRanges(_ text: String) -> [Range] {
    var ranges: [Range] = []
    var offset = 0
    var fence = ""
    var fenceIndent = 0
    var openedAt = -1
    for line in split(text, on: 0x0A) {
      let value = line as NSString
      let match = fenceLine.firstMatch(in: line, range: NSRange(location: 0, length: value.length))
      let marker = match.map { value.substring(with: $0.range(at: 1)) }
      let indent = match.map { $0.range.length - $0.range(at: 1).length } ?? 0
      if openedAt < 0 {
        let info = match.map { value.substring(from: $0.range.length) } ?? ""
        if let marker, marker.utf16.first == 0x7E || !info.utf16.contains(0x60) {
          fence = marker
          fenceIndent = indent
          openedAt = offset
        }
      } else if let marker, marker.utf16.first == fence.utf16.first,
        marker.utf16.count >= fence.utf16.count, trim(line) == marker,
        indent <= fenceIndent + 3
      {
        ranges.append((openedAt, offset + value.length))
        openedAt = -1
      }
      offset += value.length + 1
    }
    if openedAt >= 0 { ranges.append((openedAt, (text as NSString).length)) }
    return ranges
  }

  private static func blankLineRanges(_ text: String) -> [Range] {
    let units = Array(text.utf16)
    var ranges: [Range] = []
    var previous = -1
    for (index, unit) in units.enumerated() where unit == 0x0A {
      if previous >= 0, units[(previous + 1)..<index].allSatisfy({ $0 == 0x20 || $0 == 0x09 }) {
        ranges.append((previous, index + 1))
      }
      previous = index
    }
    return ranges
  }

  private static let backticks = regex("`+")

  /// Inline code spans: a backtick run closed by the next run of the same length, within one paragraph.
  private static func codeSpanRanges(_ text: String, fenced: [Range]) -> [Range] {
    let runs: [Range] = backticks.matches(
      in: text, range: NSRange(location: 0, length: (text as NSString).length)
    ).compactMap {
      inRanges($0.range.location, fenced) ? nil : ($0.range.location, NSMaxRange($0.range))
    }
    var runsByLength: [Int: [Int]] = [:]
    for (index, run) in runs.enumerated() { runsByLength[run.end - run.start, default: []].append(index) }
    var cursors: [Int: Int] = [:]
    let blankLines = blankLineRanges(text)
    var blankLine = 0
    var spans: [Range] = []
    var index = 0
    while index < runs.count {
      let run = runs[index]
      let length = run.end - run.start
      let sameLength = runsByLength[length] ?? []
      var cursor = cursors[length] ?? 0
      while cursor < sameLength.count, sameLength[cursor] <= index { cursor += 1 }
      cursors[length] = cursor
      while blankLine < blankLines.count, blankLines[blankLine].start < run.end { blankLine += 1 }
      let paragraphEnd = blankLine < blankLines.count ? blankLines[blankLine].end : Int.max
      guard cursor < sameLength.count, runs[sameLength[cursor]].start < paragraphEnd else {
        index += 1
        continue
      }
      spans.append((run.start, runs[sameLength[cursor]].end))
      index = sameLength[cursor] + 1
    }
    return spans
  }

  private static func codeRanges(_ text: String) -> [Range] {
    let fenced = fencedCodeRanges(text)
    return fenced + codeSpanRanges(text, fenced: fenced)
  }

  // MARK: Inline HTML and math

  private static let formattingTags: Set<String> = [
    "u", "ins", "b", "strong", "i", "em", "s", "strike", "del", "sub", "sup", "mark", "br",
  ]
  private static let tag = regex("<(/?)([a-zA-Z]+)\(space)*(/)?>")

  /// Removes balanced formatting tags such as `<b>…</b>` and `<br>`, leaving their text.
  private static func stripFormattingTags(_ text: String) -> String {
    guard text.utf16.contains(0x3C) else { return text }
    let value = text as NSString
    let code = codeRanges(text)
    var removed: [Range] = []
    var open: [(tag: String, range: Range)] = []
    for match in tag.matches(in: text, range: NSRange(location: 0, length: value.length)) {
      let range: Range = (match.range.location, NSMaxRange(match.range))
      let name = value.substring(with: match.range(at: 2)).lowercased()
      guard !inRanges(range.start, code), formattingTags.contains(name) else { continue }
      let closing = match.range(at: 1).length > 0
      let selfClosing = match.range(at: 3).location != NSNotFound
      if name == "br" {
        if !(closing && selfClosing) { removed.append(range) }
        continue
      }
      if selfClosing { continue }
      if !closing {
        open.append((name, range))
        continue
      }
      guard let opener = open.last, opener.tag == name else { continue }
      open.removeLast()
      removed += [opener.range, range]
    }
    guard !removed.isEmpty else { return text }
    var result = ""
    var offset = 0
    for range in removed.sorted(by: { $0.start < $1.start }) {
      result += value.substring(with: NSRange(location: offset, length: range.start - offset))
      offset = range.end
    }
    return result + value.substring(from: offset)
  }

  private static let math = regex(
    "\\$\\$(?:[^$\\\\]|\\\\[\\s\\S])+\\$\\$|\\\\\\([\\s\\S]+?\\\\\\)|\\\\\\[[\\s\\S]+?\\\\\\]")
  private static let latexTextCommand = regex(
    "\\\\(?:text(?:rm|sf|tt|normal|bf|md|it|up)?|emph|(?:textcolor|colorbox)\\{[^{}]*\\}|fcolorbox\\{[^{}]*\\}\\{[^{}]*\\})\\{([^{}]*)\\}|\\\\color\\{[^{}]*\\}"
  )

  private static func unwrapLatexText(_ math: String) -> String {
    let unwrapped = replace(latexTextCommand, in: math, with: "$1")
    return unwrapped == math ? math : unwrapLatexText(unwrapped)
  }

  /// Drops `$$…$$`, `\(…\)` and `\[…\]` delimiters, keeping the expression.
  private static func stripMathDelimiters(_ text: String) -> String {
    let value = text as NSString
    let code = codeRanges(text)
    var result = ""
    var offset = 0
    for match in math.matches(in: text, range: NSRange(location: 0, length: value.length))
    where !inRanges(match.range.location, code) {
      result += value.substring(with: NSRange(location: offset, length: match.range.location - offset))
      result += unwrapLatexText(
        value.substring(
          with: NSRange(location: match.range.location + 2, length: match.range.length - 4)))
      offset = NSMaxRange(match.range)
    }
    return result + value.substring(from: offset)
  }

  // MARK: Markdown syntax

  private static let syntax: [(pattern: NSRegularExpression, template: String)] = [
    (regex("`+"), ""),
    (regex("!\\[([^\\]]*)\\]\\([^)]*\\)"), "$1"),
    (regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1"),
    (regex("\\\\\\$"), "\\$"),
    (regex("\(lineStart)\(space){0,3}#{1,6}\(space)+"), ""),
    (regex("\(lineStart)\(space){0,3}>\(space)?"), ""),
    (regex("\(lineStart)\(space){0,3}(?:[-*+]|[0-9]+[.)])\(space)+"), ""),
    (regex("\\*\\*([^*]+)\\*\\*"), "$1"),
    (regex("__([^_]+)__"), "$1"),
    (regex("~~([^~]+)~~"), "$1"),
    (regex("\\*([^*\\n]+)\\*"), "$1"),
    (regex("(?<![A-Za-z0-9_])_([^_\\n]+)_(?![A-Za-z0-9_])"), "$1"),
    (regex("\\|"), " "),
  ]
  private static let whitespace = regex("\(space)+")

  private static func regex(_ pattern: String) -> NSRegularExpression {
    try! NSRegularExpression(pattern: pattern)
  }

  private static func replace(_ pattern: NSRegularExpression, in text: String, with template: String)
    -> String
  {
    pattern.stringByReplacingMatches(
      in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: template)
  }

  // MARK: Attachments

  private static let nouns: [String: (one: String, other: String)] = [
    "image": ("image", "images"), "video": ("video", "videos"),
    "audio": ("audio file", "audio files"), "pdf": ("PDF", "PDFs"),
    "markdown": ("Markdown file", "Markdown files"), "table": ("spreadsheet", "spreadsheets"),
    "json": ("JSON file", "JSON files"), "text": ("text file", "text files"),
    "document": ("document", "documents"), "archive": ("archive", "archives"),
    "file": ("file", "files"),
  ]

  private static func counted(_ kind: String, _ count: Int) -> String {
    let noun = nouns[kind] ?? nouns["file"]!
    return "\(count) \(count == 1 ? noun.one : noun.other)"
  }

  private static let spreadsheetTypes: Set<String> = [
    "text/csv", "text/tab-separated-values", "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]
  private static let documentTypes: Set<String> = [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]
  private static let archiveTypes: Set<String> = [
    "application/zip", "application/x-zip-compressed", "application/gzip", "application/x-tar",
    "application/x-bzip2", "application/x-xz", "application/zstd", "application/x-7z-compressed",
    "application/x-rar-compressed", "application/vnd.rar",
  ]

  private static func kind(mimeType: String) -> String? {
    let type = trim(split(mimeType, on: 0x3B)[0]).lowercased()
    if type.hasPrefix("image/") { return "image" }
    if type.hasPrefix("video/") { return "video" }
    if type.hasPrefix("audio/") { return "audio" }
    if type == "application/pdf" { return "pdf" }
    if type == "text/markdown" { return "markdown" }
    if spreadsheetTypes.contains(type) { return "table" }
    if type == "application/json" || type.hasSuffix("+json") { return "json" }
    if documentTypes.contains(type) { return "document" }
    if archiveTypes.contains(type) { return "archive" }
    return type.hasPrefix("text/") ? "text" : nil
  }

  private static let extensionKinds: [String: String] = {
    let extensions = [
      "image": "avif bmp gif ico jpeg jpg png svg webp heic heif",
      "video": "m4v mov mp4 ogv webm",
      "audio": "aac flac m4a mp3 oga ogg opus wav weba",
      "pdf": "pdf",
      "table": "csv tsv xlsx xls",
      "json": "json jsonc json5 ndjson",
      "markdown": "md markdown mdx",
      "document": "docx",
      "archive": "zip tar gz tgz bz2 tbz2 xz txz zst 7z rar",
      "text":
        "html htm txt text log rst adoc tex xml yaml yml toml ini cfg conf env properties plist "
        + "gradle css scss sass less js jsx mjs cjs ts tsx mts cts py pyi rb go rs java kt kts c h cc "
        + "cpp cxx hpp hh cs php swift scala dart lua pl pm r sql graphql gql proto vue svelte astro "
        + "sh bash zsh fish bat ps1 tf tfvars dockerfile diff patch",
    ]
    var kinds: [String: String] = [:]
    for (kind, list) in extensions {
      for value in list.split(separator: " ") { kinds[String(value)] = kind }
    }
    return kinds
  }()

  private static func kind(fileName: String) -> String? {
    let name = split(split(fileName, on: 0x2F).last ?? "", on: 0x5C).last ?? ""
    let value = name as NSString
    let dot = value.range(of: ".", options: [.literal, .backwards]).location
    guard dot != NSNotFound, dot > 0, dot < value.length - 1 else { return nil }
    return extensionKinds[value.substring(from: dot + 1).lowercased()]
  }
}

/// Rows re-render often, and a pathological first line can take tens of milliseconds to strip.
/// NSCache is thread-safe.
private final class PreviewCache: @unchecked Sendable {
  static let shared = PreviewCache()
  private let storage: NSCache<NSString, NSString> = {
    let storage = NSCache<NSString, NSString>()
    storage.countLimit = 256
    return storage
  }()

  subscript(content: String) -> String? {
    get { storage.object(forKey: content as NSString) as String? }
    set { if let newValue { storage.setObject(newValue as NSString, forKey: content as NSString) } }
  }
}

extension Message {
  /// Attachments with no text of their own; the conversation list summarizes them.
  public var isAttachmentOnly: Bool {
    !attachments.isEmpty && MessagePreview.trim(displayContent).isEmpty
  }

  /// The conversation list line for this message.
  public var previewText: String {
    isAttachmentOnly ? MessagePreview.attachments(attachments) : MessagePreview.text(content)
  }
}
