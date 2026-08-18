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
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let parts = calendar.dateComponents([.hour, .minute], from: date)
    let now = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    return max(0, departMinutes - now)
  }
}
