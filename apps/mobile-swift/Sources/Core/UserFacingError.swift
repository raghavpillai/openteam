import Foundation

/// Shared error policy for native forms, matching the existing client's recovery semantics.
public enum UserFacingError {
  public static func message(_ error: Error) -> String {
    if let network = error as? URLError {
      switch network.code {
      case .timedOut: return "The server took too long to respond. Please try again."
      case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost,
        .dnsLookupFailed:
        return
          "Could not reach your OpenTeam server. Check the address and your connection, then try again."
      case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
        .serverCertificateHasUnknownRoot:
        return
          "A secure connection could not be established. Check the server address and its certificate."
      case .cancelled: return "The request was cancelled."
      default: return "Could not complete the connection. Please try again."
      }
    }
    if error is DecodingError {
      return "The server returned an unexpected response. Try again or update your server."
    }
    return redact(error.localizedDescription)
  }
  public static func fallback(status: Int, signingIn: Bool = false) -> String {
    switch status {
    case 401:
      return signingIn
        ? "The username or password is incorrect. Check your details and try again."
        : "Your session expired. Sign in again."
    case 403:
      return signingIn
        ? "This account cannot sign in to this server. Contact your server administrator."
        : "You do not have permission to do this. Contact your server administrator."
    case 404: return "This item is no longer available. Refresh and try again."
    case 408, 504: return "The server took too long to respond. Please try again."
    case 409: return "This item changed on another device. Refresh it before trying again."
    case 413: return "This file is too large. Choose a smaller file and try again."
    case 429:
      return signingIn
        ? "Too many sign-in attempts. Wait a moment and try again."
        : "Too many requests. Wait a moment and try again."
    case 500...599: return "The server could not complete the request. Please try again shortly."
    default: return "Could not complete this request. Please try again."
    }
  }
  public static func redact(_ text: String) -> String {
    let patterns: [(String, String)] = [
      (#"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+"#, "Bearer [REDACTED]"),
      (#"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b"#, "[REDACTED]"),
      (
        #"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[pbars]-[A-Za-z0-9-]{10,})\b"#,
        "[REDACTED]"
      ),
      (
        #"(?i)([\"'](?:password|passwd|secret|token|api[_-]?key|authorization)[\"']\s*:\s*[\"'])(.*?)([\"'])"#,
        "$1[REDACTED]$3"
      ),
      (
        #"(?i)\b((?:OPENTEAM_[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)|PASSWORD|PASSWD|API_KEY|AUTH_TOKEN)\s*[=:]\s*)(\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;]+)"#,
        "$1[REDACTED]"
      ),
      (#"(?i)(https?://[^\s:/@]+:)([^\s@/]+)(@)"#, "$1[REDACTED]$3"),
    ]
    return patterns.reduce(text) { value, rule in
      value.replacingOccurrences(of: rule.0, with: rule.1, options: .regularExpression)
    }
  }
  public static func isCancelled(_ error: Error) -> Bool {
    error is CancellationError || (error as? URLError)?.code == .cancelled
  }
}
