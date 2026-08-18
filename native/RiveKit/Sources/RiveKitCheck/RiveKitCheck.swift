import Foundation
import RiveKit

/// Drives shipped RiveKit on this Mac. CLT has no XCTest / Testing.framework.
@main
enum RiveKitCheck {
  static func main() throws {
    var failed = 0

    func check(_ name: String, _ ok: @autoclosure () -> Bool) {
      if ok() {
        print("ok  \(name)")
      } else {
        print("not ok  \(name)")
        failed += 1
      }
    }

    let qc = FoundationAssist.parseLocally("horaire Youville Québec")
    check("parse quebec schedule city", qc.city == "quebec")
    check("parse quebec schedule kind", qc.kind == "schedule")
    check("parse quebec schedule query", qc.stopQuery.lowercased().contains("youville"))

    let en = FoundationAssist.parseLocally("from Berri to McGill Montreal")
    check("parse montreal english plan city", en.city == "montreal")
    check("parse montreal english plan kind", en.kind == "plan")
    check("parse montreal english plan query", en.stopQuery.lowercased().contains("berri"))

    let fr = FoundationAssist.parseLocally("trajet Berri vers McGill Montréal")
    check("parse montreal french plan city", fr.city == "montreal")
    check("parse montreal french plan kind", fr.kind == "plan")

    let levis = FoundationAssist.parseLocally("horaire Traverse Lévis")
    check("parse levis maps to quebec", levis.city == "quebec")
    let laval = FoundationAssist.parseLocally("horaire Montmorency stlaval")
    check("parse stlaval maps to montreal", laval.city == "montreal")

    let bare = FoundationAssist.parseLocally("  Youville  ")
    check("parse bare stop has no city", bare.city == nil)
    check("parse bare stop is schedule", bare.kind == "schedule")
    check("parse bare stop trimmed", bare.stopQuery == "Youville")

    let line = FoundationAssist.parseModelLine("quebec|schedule|Youville")
    check("model line city", line?.city == "quebec")
    check("model line kind", line?.kind == "schedule")
    check("model line query", line?.stopQuery == "Youville")
    check("model line garbage", FoundationAssist.parseModelLine("not-a-line") == nil)
    check("model line empty query", FoundationAssist.parseModelLine("quebec|schedule|") == nil)

    let live = LiveDeparture(
      stopName: "Station Berri-UQAM",
      city: "montreal",
      routeShortName: "1",
      headsign: "Angrignon",
      colorHex: "#00A651",
      departMinutes: 960,
      clocks: ["16:00", "16:08"],
      updated: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let data = try JSONEncoder().encode(live)
    let back = try JSONDecoder().decode(LiveDeparture.self, from: data)
    check("live encode/decode equality", back == live)
    check("live stop name", back.stopName == live.stopName)
    check("live route", back.routeShortName == "1")
    check("live clocks", back.clocks == ["16:00", "16:08"])

    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Montreal")!
    var parts = DateComponents()
    parts.year = 2026
    parts.month = 8
    parts.day = 18
    parts.hour = 13
    parts.minute = 10
    let date = calendar.date(from: parts)!
    let youville = LiveDeparture(
      stopName: "D'Youville",
      city: "quebec",
      routeShortName: "801",
      headsign: "Terminus Beauport",
      colorHex: "#0071e3",
      departMinutes: 800,
      clocks: ["13:20"],
      updated: Date(timeIntervalSince1970: 1_700_000_000)
    )
    check("watch remain minutes", youville.remainMinutes(at: date) == 10)
    check("watch remain empty payload is idle", LiveDeparture.remainMinutes(departs: [], at: date) == nil)
    check("watch remain missing depart is idle", LiveDeparture.remainMinutes(departMinutes: nil, at: date) == nil)
    check("watch remain list picks soonest", LiveDeparture.remainMinutes(departs: [800, 830], at: date) == 10)
    check("watch remain past depart is idle", LiveDeparture.remainMinutes(departMinutes: 700, at: date) == nil)

    let repoRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let pusherURL = repoRoot.appendingPathComponent("ios/Rive/LiveDeparturePusher.swift")
    let pusher = try String(contentsOf: pusherURL)
    check("live pusher can end", pusher.contains("static func end"))
    check("live pusher applies web command", pusher.contains("static func apply"))
    let shellURL = repoRoot.appendingPathComponent("ios/RiveApp/RiveApp.swift")
    let shell = try String(contentsOf: shellURL)
    check("iphone shell receives riveLive", shell.contains("riveLive"))

    let faceURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("RiveWatch/WatchPulseView.swift")
    let face = try String(contentsOf: faceURL)
    check("watch face pulses LiveDeparture", face.contains("LiveDeparture"))
    check("watch face uses remainMinutes", face.contains("remainMinutes"))
    check("watch face is not a planner", !face.contains("planTrip") && !face.contains("searchAtlas"))

    if failed > 0 {
      print("\(failed) failed")
      exit(1)
    }
    print("all passed")
  }
}
