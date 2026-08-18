#if canImport(ActivityKit)
import ActivityKit
import Foundation

public struct TransitAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable, Sendable {
    public var stopName: String
    public var routeShortName: String
    public var headsign: String
    public var colorHex: String
    public var waitMinutes: Int
    public var clocks: [String]

    public init(
      stopName: String,
      routeShortName: String,
      headsign: String,
      colorHex: String,
      waitMinutes: Int,
      clocks: [String]
    ) {
      self.stopName = stopName
      self.routeShortName = routeShortName
      self.headsign = headsign
      self.colorHex = colorHex
      self.waitMinutes = waitMinutes
      self.clocks = clocks
    }
  }

  public var city: String

  public init(city: String) {
    self.city = city
  }
}
#endif
