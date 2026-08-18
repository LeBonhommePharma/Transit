import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// On-device Apple Foundation Model: turn a spoken or typed line into a stop query.
/// The GTFS timetable and planner remain the source of departure times.
public enum FoundationAssist {
  public static func parseLocally(_ text: String) -> TransitIntent {
    let folded = text.lowercased()
    var city: String?
    if folded.contains("montréal") || folded.contains("montreal") || folded.contains("mtl") {
      city = "montreal"
    }
    if folded.contains("québec") || folded.contains("quebec") {
      city = "quebec"
    }
    let kind =
      folded.contains("vers") || folded.contains("to ") || folded.contains("trajet")
      ? "plan" : "schedule"
    return TransitIntent(city: city, stopQuery: text.trimmingCharacters(in: .whitespaces), kind: kind)
  }

  @available(iOS 26.0, macOS 26.0, watchOS 26.0, *)
  public static func understand(_ text: String) async -> TransitIntent {
    #if canImport(FoundationModels)
    do {
      let session = LanguageModelSession(
        instructions: """
          You extract a public-transit lookup for Québec RTC or Montréal STM.
          Return city as quebec or montreal when named, else omit it.
          stopQuery is the stop or place to look up. kind is schedule or plan.
          Never invent times. Never compute a path.
          """
      )
      let reply = try await session.respond(to: text, generating: TransitIntent.self)
      if reply.content.stopQuery.isEmpty {
        return parseLocally(text)
      }
      return reply.content
    } catch {
      return parseLocally(text)
    }
    #else
    return parseLocally(text)
    #endif
  }
}
