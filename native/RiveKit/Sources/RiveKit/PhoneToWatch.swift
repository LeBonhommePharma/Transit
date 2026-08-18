import Foundation

#if canImport(WatchConnectivity)
import WatchConnectivity

/// iPhone is the brain. The Watch only displays this payload.
public final class PhoneToWatch: NSObject, WCSessionDelegate, Sendable {
  public static let shared = PhoneToWatch()

  private override init() {
    super.init()
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  public func publish(_ live: LiveDeparture) {
    guard WCSession.default.activationState == .activated else { return }
    let data = (try? JSONEncoder().encode(live)) ?? Data()
    try? WCSession.default.updateApplicationContext(["live": data])
    if WCSession.default.isReachable {
      WCSession.default.sendMessage(["tick": data], replyHandler: nil, errorHandler: nil)
    }
  }

  public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

  #if os(iOS)
  public func sessionDidBecomeInactive(_ session: WCSession) {}
  public func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }
  #endif
}
#endif
