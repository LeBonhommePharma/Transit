#if canImport(ActivityKit)
import ActivityKit
import Foundation
import RiveKit

/// Starts an iPhone Live Activity. watchOS mirrors it; PhoneToWatch also pushes a pulse.
enum LiveDeparturePusher {
  static func start(city: String, live: LiveDeparture) throws {
    PhoneToWatch.shared.publish(live)
    let attrs = TransitAttributes(city: city)
    let state = TransitAttributes.ContentState(
      stopName: live.stopName,
      routeShortName: live.routeShortName,
      headsign: live.headsign,
      colorHex: live.colorHex,
      waitMinutes: live.departMinutes,
      clocks: live.clocks
    )
    _ = try Activity<TransitAttributes>.request(
      attributes: attrs,
      content: .init(state: state, staleDate: Date().addingTimeInterval(45 * 60)),
      pushType: nil
    )
  }

  static func tick(_ live: LiveDeparture) async {
    PhoneToWatch.shared.publish(live)
    let state = TransitAttributes.ContentState(
      stopName: live.stopName,
      routeShortName: live.routeShortName,
      headsign: live.headsign,
      colorHex: live.colorHex,
      waitMinutes: live.departMinutes,
      clocks: live.clocks
    )
    for activity in Activity<TransitAttributes>.activities {
      await activity.update(.init(state: state, staleDate: Date().addingTimeInterval(30 * 60)))
    }
  }
}
#endif
