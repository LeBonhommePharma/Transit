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
    if folded.contains("montréal") || folded.contains("montreal") || folded.contains("mtl")
      || folded.contains("stlaval")
    {
      city = "montreal"
    }
    if folded.contains("québec") || folded.contains("quebec") || folded.contains("levis")
      || folded.contains("lévis") || folded.contains("stlevis")
    {
      city = "quebec"
    }
    let kind =
      folded.contains("vers")
        || folded.contains("to ")
        || folded.contains("from ")
        || folded.contains("trajet")
        || folded.contains("itineraire")
        || folded.contains("itinéraire")
        || folded.contains("itinerary")
      ? "plan" : "schedule"
    return TransitIntent(
      city: city,
      stopQuery: text.trimmingCharacters(in: .whitespacesAndNewlines),
      kind: kind
    )
  }

  @available(iOS 26.0, macOS 26.0, *)
  public static func understand(_ text: String) async -> TransitIntent {
    #if canImport(FoundationModels)
    do {
      let session = LanguageModelSession(
        instructions: """
          You extract a public-transit lookup for Québec (RTC, STLévis) or Montréal (STM, STL Laval).
          Reply with one line: city|kind|query
          city is quebec or montreal or -
          kind is schedule or plan
          query is the stop or place. Never invent times. Never compute a path.
          """
      )
      let reply = try await session.respond(to: text)
      if let parsed = parseModelLine(reply.content) {
        return parsed
      }
      return parseLocally(text)
    } catch {
      return parseLocally(text)
    }
    #else
    return parseLocally(text)
    #endif
  }

  /// Interprets the `city|kind|query` line the on-device model is asked to return.
  public static func parseModelLine(_ raw: String) -> TransitIntent? {
    let parts = raw.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard parts.count == 3 else { return nil }
    let cityRaw = parts[0].lowercased()
    let kindRaw = parts[1].lowercased()
    let query = parts[2]
    guard !query.isEmpty else { return nil }
    let city: String?
    if cityRaw == "quebec" || cityRaw == "québec" { city = "quebec" }
    else if cityRaw == "montreal" || cityRaw == "montréal" || cityRaw == "mtl" { city = "montreal" }
    else { city = nil }
    let kind = (kindRaw == "plan") ? "plan" : "schedule"
    return TransitIntent(city: city, stopQuery: query, kind: kind)
  }
}
