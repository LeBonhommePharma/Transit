import SwiftUI
import RiveKit

/// Not a cloned phone app. Renders the last LiveDeparture the iPhone published.
@main
struct RiveWatchApp: App {
  @State private var live = LiveDeparture(
    stopName: "Ouvre un arrêt sur l'iPhone",
    city: "quebec",
    routeShortName: "Rive",
    headsign: "",
    colorHex: "#0071e3",
    departMinutes: 0,
    clocks: []
  )

  var body: some Scene {
    WindowGroup {
      WatchPulseView(live: live)
    }
  }
}
