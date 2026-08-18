#if canImport(ActivityKit)
import ActivityKit
import Foundation
import RiveKit

/// Starts an iPhone Live Activity. watchOS mirrors it; PhoneToWatch also pushes a pulse.
enum LiveDeparturePusher {
  static func contentState(for live: LiveDeparture, remain: Int) -> TransitAttributes.ContentState {
    TransitAttributes.ContentState(
      stopName: live.stopName,
      routeShortName: live.routeShortName,
      headsign: live.headsign,
      colorHex: live.colorHex,
      waitMinutes: remain,
      clocks: live.clocks
    )
  }

  static func start(city: String, live: LiveDeparture, remain: Int? = nil) throws {
    let wait = remain ?? live.remainMinutes(at: Date())
    PhoneToWatch.shared.publish(live)
    if Activity<TransitAttributes>.activities.isEmpty {
      let attrs = TransitAttributes(city: city)
      _ = try Activity<TransitAttributes>.request(
        attributes: attrs,
        content: .init(state: contentState(for: live, remain: wait), staleDate: Date().addingTimeInterval(45 * 60)),
        pushType: nil
      )
    } else {
      Task { await tick(live, remain: wait) }
    }
  }

  static func tick(_ live: LiveDeparture, remain: Int? = nil) async {
    let wait = remain ?? live.remainMinutes(at: Date())
    PhoneToWatch.shared.publish(live)
    let state = contentState(for: live, remain: wait)
    for activity in Activity<TransitAttributes>.activities {
      await activity.update(.init(state: state, staleDate: Date().addingTimeInterval(30 * 60)))
    }
  }

  static func end() async {
    PhoneToWatch.shared.clear()
    for activity in Activity<TransitAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  static func apply(command: [String: Any]) {
    let action = command["action"] as? String ?? ""
    if action == "end" || action.isEmpty {
      Task { await end() }
      return
    }
    let route = command["route"] as? String ?? ""
    let departs = (command["departs"] as? [Any] ?? []).compactMap { value -> Int? in
      if let n = value as? Int { return n }
      if let n = value as? Double { return Int(n) }
      return Int(String(describing: value))
    }
    if route.isEmpty || departs.isEmpty {
      Task { await end() }
      return
    }
    let remain = (command["remain"] as? Int) ?? LiveDeparture.remainMinutes(departs: departs, at: Date()) ?? 0
    let live = LiveDeparture(
      stopName: command["stop"] as? String ?? "",
      city: command["city"] as? String ?? "quebec",
      routeShortName: route,
      headsign: command["headsign"] as? String ?? "",
      colorHex: command["color"] as? String ?? "#0071e3",
      departMinutes: departs[0],
      clocks: command["clocks"] as? [String] ?? []
    )
    if action == "update", !Activity<TransitAttributes>.activities.isEmpty {
      Task { await tick(live, remain: remain) }
      return
    }
    try? start(city: live.city, live: live, remain: remain)
  }
}
#endif
