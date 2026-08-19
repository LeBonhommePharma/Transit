import Foundation
import simd

#if canImport(Metal)
import Metal
#endif

/// Lambert wall shade. Metal on Apple GPUs; CPU otherwise. Same ambient as the JS atlas.
public enum BuildingShade {
  public static let ambient: Float = 0.22

  public struct Result: Sendable, Equatable {
    public var backend: String
    public var shades: [Float]

    public init(backend: String, shades: [Float]) {
      self.backend = backend
      self.shades = shades
    }
  }

  public static func shadeCPU(normals: [SIMD3<Float>], light: SIMD3<Float>) -> [Float] {
    let llen = simd_length(light)
    return normals.map { n in
      let nn = simd_length(n)
      guard nn > 0, llen > 0 else { return 0 }
      let d = simd_dot(n / nn, light / llen)
      return ambient + (1 - ambient) * max(0, d)
    }
  }

  /// Metal compute when a system GPU exists; otherwise nil.
  public static func shadeMetal(normals: [SIMD3<Float>], light: SIMD3<Float>) -> [Float]? {
    #if canImport(Metal)
    MetalShadeEngine.shared.shade(normals: normals, light: light)
    #else
    nil
    #endif
  }

  public static var metalAvailable: Bool {
    #if canImport(Metal)
    MetalShadeEngine.shared.device != nil && MetalShadeEngine.shared.pipeline != nil
    #else
    false
    #endif
  }

  /// Prefer Metal on Apple; CPU if the kernel cannot run.
  public static func shadeBest(normals: [SIMD3<Float>], light: SIMD3<Float>) -> Result {
    if let gpu = shadeMetal(normals: normals, light: light) {
      return Result(backend: "metal", shades: gpu)
    }
    return Result(backend: "cpu", shades: shadeCPU(normals: normals, light: light))
  }
}

#if canImport(Metal)
private final class MetalShadeEngine: @unchecked Sendable {
  static let shared = MetalShadeEngine()

  let device: MTLDevice?
  let queue: MTLCommandQueue?
  let pipeline: MTLComputePipelineState?

  private init() {
    let device = MTLCreateSystemDefaultDevice()
    self.device = device
    self.queue = device?.makeCommandQueue()
    var pipeline: MTLComputePipelineState?
    if let device {
      let options = MTLCompileOptions()
      if let library = try? device.makeLibrary(source: Self.source, options: options),
        let function = library.makeFunction(name: "shadeWalls")
      {
        pipeline = try? device.makeComputePipelineState(function: function)
      }
    }
    self.pipeline = pipeline
  }

  func shade(normals: [SIMD3<Float>], light: SIMD3<Float>) -> [Float]? {
    let count = normals.count
    if count == 0 { return [] }
    guard count <= 20_000, let device, let queue, let pipeline else { return nil }
    var packed = [SIMD4<Float>](repeating: .zero, count: count)
    for i in 0..<count {
      let n = normals[i]
      packed[i] = SIMD4<Float>(n.x, n.y, n.z, 0)
    }
    var params = ShadeParams(
      light: SIMD4<Float>(light.x, light.y, light.z, BuildingShade.ambient),
      count: UInt32(count),
      p0: 0,
      p1: 0,
      p2: 0
    )
    let normalBytes = count * MemoryLayout<SIMD4<Float>>.stride
    let shadeBytes = max(16, count * MemoryLayout<Float>.stride)
    guard
      let normalBuffer = device.makeBuffer(bytes: packed, length: normalBytes, options: .storageModeShared),
      let paramBuffer = device.makeBuffer(bytes: &params, length: MemoryLayout<ShadeParams>.stride, options: .storageModeShared),
      let shadeBuffer = device.makeBuffer(length: shadeBytes, options: .storageModeShared),
      let command = queue.makeCommandBuffer(),
      let encoder = command.makeComputeCommandEncoder()
    else { return nil }
    encoder.setComputePipelineState(pipeline)
    encoder.setBuffer(normalBuffer, offset: 0, index: 0)
    encoder.setBuffer(paramBuffer, offset: 0, index: 1)
    encoder.setBuffer(shadeBuffer, offset: 0, index: 2)
    let width = max(pipeline.threadExecutionWidth, 1)
    let threads = MTLSize(width: width, height: 1, depth: 1)
    let groups = MTLSize(width: (count + width - 1) / width, height: 1, depth: 1)
    encoder.dispatchThreadgroups(groups, threadsPerThreadgroup: threads)
    encoder.endEncoding()
    command.commit()
    command.waitUntilCompleted()
    if command.status == .error { return nil }
    let pointer = shadeBuffer.contents().bindMemory(to: Float.self, capacity: count)
    return Array(UnsafeBufferPointer(start: pointer, count: count))
  }

  private static let source = """
    #include <metal_stdlib>
    using namespace metal;

    struct Params {
      float4 light;
      uint count;
      uint p0;
      uint p1;
      uint p2;
    };

    kernel void shadeWalls(
      device const float4 *normals [[buffer(0)]],
      constant Params &params [[buffer(1)]],
      device float *shades [[buffer(2)]],
      uint gid [[thread_position_in_grid]]
    ) {
      if (gid >= params.count) {
        return;
      }
      float3 nraw = normals[gid].xyz;
      float nlen = length(nraw);
      float3 lraw = params.light.xyz;
      float llen = length(lraw);
      float s = 0.0;
      if (nlen > 0.0 && llen > 0.0) {
        float d = dot(nraw / nlen, lraw / llen);
        float ambient = params.light.w;
        s = ambient + (1.0 - ambient) * max(d, 0.0);
      }
      shades[gid] = s;
    }
    """
}

private struct ShadeParams {
  var light: SIMD4<Float>
  var count: UInt32
  var p0: UInt32
  var p1: UInt32
  var p2: UInt32
}
#endif
