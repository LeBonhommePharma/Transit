import Foundation

/// Payload the iPhone publishes. The Watch only renders it.
public struct LiveDeparture: Codable, Hashable, Sendable {
  public var stopName: String
  public var city: String
  public var routeShortName: String
  public var headsign: String
  public var colorHex: String
  public var departMinutes: Int
  public var clocks: [String]
  public var updated: Date

  public init(
    stopName: String,
    city: String,
    routeShortName: String,
    headsign: String,
    colorHex: String,
    departMinutes: Int,
    clocks: [String],
    updated: Date = Date()
  ) {
    self.stopName = stopName
    self.city = city
    self.routeShortName = routeShortName
    self.headsign = headsign
    self.colorHex = colorHex
    self.departMinutes = departMinutes
    self.clocks = clocks
    self.updated = updated
  }

  /// Minutes until the published departure, in America/Montreal wall time.
  public func remainMinutes(
    at date: Date,
    timeZone: TimeZone = TimeZone(identifier: "America/Montreal") ?? .current
  ) -> Int {
    Self.remainMinutes(departMinutes: departMinutes, at: date, timeZone: timeZone) ?? 0
  }

  /// Empty or missing departs stay idle (`nil`). Never throws.
  public static func remainMinutes(
    departMinutes: Int?,
    at date: Date,
    timeZone: TimeZone = TimeZone(identifier: "America/Montreal") ?? .current
  ) -> Int? {
    guard let departMinutes else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let parts = calendar.dateComponents([.hour, .minute], from: date)
    let now = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    var depart = departMinutes
    if depart < now - 90 { depart += 1440 }
    let wait = depart - now
    return wait < 0 ? nil : wait
  }

  public static func remainMinutes(
    departs: [Int],
    at date: Date,
    timeZone: TimeZone = TimeZone(identifier: "America/Montreal") ?? .current
  ) -> Int? {
    if departs.isEmpty { return nil }
    var best: Int?
    for depart in departs {
      guard let wait = remainMinutes(departMinutes: depart, at: date, timeZone: timeZone) else { continue }
      if best == nil || wait < best! { best = wait }
    }
    return best
  }
}
