import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Structured query the on-device model must return.
/// Path math is never delegated to the model.
public struct TransitIntent: Codable, Sendable, Equatable {
  public var city: String?
  public var stopQuery: String
  public var kind: String

  public init(city: String? = nil, stopQuery: String, kind: String = "schedule") {
    self.city = city
    self.stopQuery = stopQuery
    self.kind = kind
  }
}

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, watchOS 26.0, *)
extension TransitIntent: Generable {}
#endif
