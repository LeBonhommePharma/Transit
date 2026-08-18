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
}
