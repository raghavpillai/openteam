import Foundation

/// One line of plain text describing a message, for the conversation list.
/// Mirrors packages/contracts/src/message-preview.ts; Tests/CoreTests/Fixtures/message-previews.json
/// is exported from it by scripts/export-message-previews.ts.
public enum MessagePreview {
  /// Longest preview, in UTF-16 code units, including the trailing ellipsis.
  public static let limit = 200
  private static let markdownScanLimit = 4_096

  /// The first non-empty line of a message, as plain text.
  public static func text(_ content: String, limit: Int = limit) -> String {
    let line =
      (content as NSString).components(separatedBy: "\n")
      .first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? ""
    let scanned =
      (line as NSString).length <= markdownScanLimit ? line : prefix(line, markdownScanLimit)
    return truncate(plainText(scanned), limit: limit)
  }

  /// Markdown as the plain text a reader sees, on one line.
  public static func plainText(_ markdown: String) -> String {
    let stripped = syntax.reduce(stripMathDelimiters(stripFormattingTags(markdown))) {
      text, rule in replace(rule.pattern, in: text, with: rule.template)
    }
    return replace(whitespace, in: stripped, with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public static func truncate(_ value: String, limit: Int = limit) -> String {
    guard (value as NSString).length > limit else { return value }
    let cut = prefix(value, limit - 1)
    let end = cut.lastIndex { !$0.isWhitespace }.map { cut.index(after: $0) } ?? cut.startIndex
    return String(cut[..<end]) + "…"
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
    if let fileName, !fileName.isEmpty, let kind = kind(path: fileName) { return kind }
    return "file"
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
    for line in (text as NSString).components(separatedBy: "\n") {
      let value = line as NSString
      let match = fenceLine.firstMatch(in: line, range: NSRange(location: 0, length: value.length))
      let marker = match.map { value.substring(with: $0.range(at: 1)) }
      let indent = match.map { $0.range.length - $0.range(at: 1).length } ?? 0
      if openedAt < 0 {
        let info = match.map { value.substring(from: $0.range.length) } ?? ""
        if let marker, marker.first == "~" || !info.contains("`") {
          fence = marker
          fenceIndent = indent
          openedAt = offset
        }
      } else if let marker, marker.first == fence.first, marker.count >= fence.count,
        line.trimmingCharacters(in: .whitespacesAndNewlines) == marker,
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
  private static let tag = regex("<(/?)([a-zA-Z]+)\\s*(/)?>")

  /// Removes balanced formatting tags such as `<b>…</b>` and `<br>`, leaving their text.
  private static func stripFormattingTags(_ text: String) -> String {
    guard text.contains("<") else { return text }
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
    (regex("^\\s{0,3}#{1,6}\\s+", lines: true), ""),
    (regex("^\\s{0,3}>\\s?", lines: true), ""),
    (regex("^\\s{0,3}(?:[-*+]|[0-9]+[.)])\\s+", lines: true), ""),
    (regex("\\*\\*([^*]+)\\*\\*"), "$1"),
    (regex("__([^_]+)__"), "$1"),
    (regex("~~([^~]+)~~"), "$1"),
    (regex("\\*([^*\\n]+)\\*"), "$1"),
    (regex("(?<![A-Za-z0-9_])_([^_\\n]+)_(?![A-Za-z0-9_])"), "$1"),
    (regex("\\|"), " "),
  ]
  private static let whitespace = regex("\\s+")

  private static func regex(_ pattern: String, lines: Bool = false) -> NSRegularExpression {
    try! NSRegularExpression(pattern: pattern, options: lines ? [.anchorsMatchLines] : [])
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
    let type = (mimeType.split(separator: ";", omittingEmptySubsequences: false).first.map(String.init) ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
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

  private static func kind(path: String) -> String? {
    var pathname = path
    if let url = URL(string: path), url.scheme != nil { pathname = url.path(percentEncoded: true) }
    pathname = pathname.removingPercentEncoding ?? pathname
    let name =
      pathname.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }.last.map(String.init)
      ?? ""
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex,
      name.index(after: dot) != name.endIndex
    else { return nil }
    return extensionKinds[name[name.index(after: dot)...].lowercased()]
  }
}

extension Message {
  /// The conversation list line for this message.
  public var previewText: String {
    let assets = attachments
    if !assets.isEmpty, displayContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return MessagePreview.attachments(assets)
    }
    return MessagePreview.text(content)
  }
}
