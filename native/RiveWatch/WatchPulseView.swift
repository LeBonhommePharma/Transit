import SwiftUI
import RiveKit

/// Not a cloned phone app. A pulse the iPhone pushes to the Watch.
public struct WatchPulseView: View {
  public var live: LiveDeparture
  @State private var beat = false

  public init(live: LiveDeparture) {
    self.live = live
  }

  public var body: some View {
    let ink = Color(red: 16 / 255, green: 22 / 255, blue: 28 / 255)
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let remain = max(0, live.departMinutes - minutesOfDay(context.date))
      ZStack {
        ink.ignoresSafeArea()
        Circle()
          .fill(Color(hex: live.colorHex).opacity(beat ? 0.55 : 0.22))
          .scaleEffect(beat ? 1.08 : 0.92)
          .blur(radius: 18)
        VStack(spacing: 2) {
          Text(live.routeShortName)
            .font(.system(size: 22, weight: .bold, design: .rounded))
          Text(remain == 0 ? "now" : "\(remain)")
            .font(.system(size: remain > 99 ? 36 : 52, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .minimumScaleFactor(0.5)
          Text(live.stopName)
            .font(.system(size: 11, weight: .medium))
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .foregroundStyle(.white.opacity(0.72))
          Text(live.clocks.prefix(3).joined(separator: "  "))
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(.white.opacity(0.5))
        }
        .padding(8)
      }
      .onChange(of: remain) { _, _ in
        withAnimation(.easeInOut(duration: 0.8)) { beat.toggle() }
      }
    }
  }

  private func minutesOfDay(_ date: Date) -> Int {
    let parts = Calendar.current.dateComponents(in: TimeZone(identifier: "America/Montreal")!, from: date)
    return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
  }
}

private extension Color {
  init(hex: String) {
    var raw = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    if raw.count == 3 { raw = raw.map { "\($0)\($0)" }.joined() }
    var value: UInt64 = 0
    Scanner(string: raw).scanHexInt64(&value)
    self.init(
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255
    )
  }
}
