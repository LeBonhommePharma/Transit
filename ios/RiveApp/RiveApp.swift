import SwiftUI
#if canImport(WebKit)
import WebKit
#endif
import RiveKit

/// Personal-team iPhone shell. The atlas is the live site; this app only pulses Watch + Live Activity.
@main
struct RiveApp: App {
  var body: some Scene {
    WindowGroup {
      AtlasWebView(url: URL(string: "https://thebonhomme.com/transit/")!)
        .ignoresSafeArea()
    }
  }
}

#if canImport(WebKit)
struct AtlasWebView: UIViewRepresentable {
  let url: URL

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeUIView(context: Context) -> WKWebView {
    let content = WKWebViewConfiguration()
    content.userContentController.add(context.coordinator, name: "riveLive")
    content.userContentController.add(context.coordinator, name: "riveShade")
    content.userContentController.addUserScript(
      WKUserScript(source: "globalThis.__riveMetal=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    )
    let view = WKWebView(frame: .zero, configuration: content)
    context.coordinator.webView = view
    view.load(URLRequest(url: url))
    return view
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    func userContentController(
      _ userContentController: WKUserContentController,
      didReceive message: WKScriptMessage
    ) {
      if message.name == "riveShade" {
        replyShade(message)
        return
      }
      guard message.name == "riveLive" else { return }
      let body: [String: Any]
      if let dict = message.body as? [String: Any] {
        body = dict
      } else {
        body = ["action": "end"]
      }
      #if canImport(ActivityKit)
      LiveDeparturePusher.apply(command: body)
      #endif
    }

    private func replyShade(_ message: WKScriptMessage) {
      guard let webView, let body = message.body as? [String: Any] else { return }
      let idJSON: String
      if let number = body["id"] as? NSNumber {
        idJSON = number.stringValue
      } else if let text = body["id"] as? String, let data = try? JSONSerialization.data(withJSONObject: [text]),
        let wrapped = String(data: data, encoding: .utf8)
      {
        idJSON = String(wrapped.dropFirst().dropLast())
      } else {
        return
      }
      let flat = floatList(body["normals"])
      var normals: [SIMD3<Float>] = []
      var i = 0
      while i + 2 < flat.count && normals.count < 20_000 {
        normals.append(SIMD3<Float>(flat[i], flat[i + 1], flat[i + 2]))
        i += 3
      }
      let lightParts = floatList(body["light"])
      let light = SIMD3<Float>(
        lightParts.count > 0 ? lightParts[0] : 0,
        lightParts.count > 1 ? lightParts[1] : 0,
        lightParts.count > 2 ? lightParts[2] : 0
      )
      let result = BuildingShade.shadeBest(normals: normals, light: light)
      let payload: [String: Any] = [
        "backend": result.backend,
        "shades": result.shades.map { Double($0) },
      ]
      guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload),
        let json = String(data: data, encoding: .utf8)
      else { return }
      webView.evaluateJavaScript(
        "globalThis.__riveMetalShadeResolve&&globalThis.__riveMetalShadeResolve(\(idJSON),\(json))",
        completionHandler: nil
      )
    }

    private func floatList(_ value: Any?) -> [Float] {
      if let numbers = value as? [NSNumber] { return numbers.map { $0.floatValue } }
      if let numbers = value as? [Double] { return numbers.map { Float($0) } }
      if let numbers = value as? [Int] { return numbers.map { Float($0) } }
      return []
    }
  }
}
#else
struct AtlasWebView: View {
  let url: URL
  var body: some View {
    Text(url.absoluteString)
  }
}
#endif
