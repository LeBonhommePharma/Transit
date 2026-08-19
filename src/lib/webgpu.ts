import { SHADE_AMBIENT, shadeMany, type Vec3 } from "./shade";

export type GpuLike = {
  requestAdapter?: (...args: unknown[]) => Promise<unknown>;
} | null | undefined;

export type GpuAdapterLike = {
  requestDevice?: (...args: unknown[]) => Promise<unknown>;
};

type GpuBufferLike = {
  getMappedRange?: (offset?: number, size?: number) => ArrayBuffer;
  unmap?: () => void;
  mapAsync?: (mode: number, offset?: number, size?: number) => Promise<void>;
  destroy?: () => void;
};

type GpuPassLike = {
  setPipeline?: (pipeline: unknown) => void;
  setBindGroup?: (index: number, group: unknown) => void;
  dispatchWorkgroups?: (x: number, y?: number, z?: number) => void;
  end?: () => void;
};

type GpuEncoderLike = {
  beginComputePass?: (desc?: unknown) => GpuPassLike | undefined;
  copyBufferToBuffer?: (src: unknown, srcOffset: number, dst: unknown, dstOffset: number, size: number) => void;
  finish?: () => unknown;
};

export type GpuDeviceLike = {
  createShaderModule?: (desc: { code: string }) => unknown;
  createComputePipeline?: (desc: unknown) => unknown;
  createBuffer?: (desc: { size: number; usage: number; mappedAtCreation?: boolean }) => GpuBufferLike | undefined;
  createBindGroup?: (desc: unknown) => unknown;
  createCommandEncoder?: (desc?: unknown) => GpuEncoderLike | undefined;
  queue?: {
    writeBuffer?: (buffer: unknown, offset: number, data: BufferSource, dataOffset?: number, size?: number) => void;
    submit?: (commands: unknown[]) => void;
  };
};

const STORAGE = 0x80;
const COPY_SRC = 0x04;
const COPY_DST = 0x08;
const MAP_READ = 0x01;
const UNIFORM = 0x40;
const MAP_READ_MODE = 0x0001;

export const SHADE_WGSL = `struct Params {
  light : vec4<f32>,
  count : u32,
  _p0 : u32,
  _p1 : u32,
  _p2 : u32,
};

@group(0) @binding(0) var<storage, read> normals : array<vec4<f32>>;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var<storage, read_write> shades : array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) {
    return;
  }
  let nraw = normals[i].xyz;
  let nlen = length(nraw);
  let lraw = params.light.xyz;
  let llen = length(lraw);
  var s = 0.0;
  if (nlen > 0.0 && llen > 0.0) {
    let d = dot(nraw / nlen, lraw / llen);
    let ambient = params.light.w;
    s = ambient + (1.0 - ambient) * max(d, 0.0);
  }
  shades[i] = s;
}
`;

const deviceCache = new WeakMap<object, Promise<GpuDeviceLike | null>>();

/** Shipped WebGPU probe. Safe when navigator.gpu is missing. */
export async function probeGpuLabel(gpu: GpuLike): Promise<string> {
  if (!gpu || typeof gpu.requestAdapter !== "function") return "Canvas 2D";
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? "WebGPU prêt" : "Canvas 2D";
  } catch {
    return "Canvas 2D";
  }
}

/** Local adapter → device. Missing GPU or incomplete adapter → null, never throws. */
export async function acquireGpuDevice(gpu: GpuLike): Promise<GpuDeviceLike | null> {
  if (!gpu || typeof gpu.requestAdapter !== "function") return null;
  const requestAdapter = gpu.requestAdapter;
  const key = gpu as object;
  const cached = deviceCache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const adapter = (await requestAdapter()) as GpuAdapterLike | null | undefined;
      if (!adapter || typeof adapter.requestDevice !== "function") return null;
      const device = (await adapter.requestDevice()) as GpuDeviceLike | null | undefined;
      return device || null;
    } catch {
      return null;
    }
  })();
  deviceCache.set(key, pending);
  return pending;
}

async function shadeWallsOnDevice(
  device: GpuDeviceLike,
  walls: Vec3[],
  light: Vec3,
): Promise<number[] | null> {
  if (
    typeof device.createShaderModule !== "function" ||
    typeof device.createComputePipeline !== "function" ||
    typeof device.createBuffer !== "function" ||
    typeof device.createBindGroup !== "function" ||
    typeof device.createCommandEncoder !== "function" ||
    !device.queue ||
    typeof device.queue.writeBuffer !== "function" ||
    typeof device.queue.submit !== "function"
  ) {
    return null;
  }
  const count = walls.length;
  if (count === 0) return [];
  const normalBytes = count * 16;
  const shadeBytes = Math.max(16, count * 4);
  const normalData = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const n = walls[i];
    normalData[i * 4] = n.x;
    normalData[i * 4 + 1] = n.y;
    normalData[i * 4 + 2] = n.z;
    normalData[i * 4 + 3] = 0;
  }
  const paramData = new ArrayBuffer(32);
  const paramF = new Float32Array(paramData, 0, 4);
  const paramU = new Uint32Array(paramData, 16, 4);
  paramF[0] = light.x;
  paramF[1] = light.y;
  paramF[2] = light.z;
  paramF[3] = SHADE_AMBIENT;
  paramU[0] = count;
  try {
    const module = device.createShaderModule({ code: SHADE_WGSL });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const normalBuffer = device.createBuffer({ size: normalBytes, usage: STORAGE | COPY_DST });
    const paramBuffer = device.createBuffer({ size: 32, usage: UNIFORM | COPY_DST });
    const shadeBuffer = device.createBuffer({ size: shadeBytes, usage: STORAGE | COPY_SRC });
    const readBuffer = device.createBuffer({ size: shadeBytes, usage: MAP_READ | COPY_DST });
    if (!normalBuffer || !paramBuffer || !shadeBuffer || !readBuffer) return null;
    device.queue.writeBuffer(normalBuffer, 0, normalData);
    device.queue.writeBuffer(paramBuffer, 0, paramData);
    const bindGroup = device.createBindGroup({
      layout: (pipeline as { getBindGroupLayout?: (i: number) => unknown }).getBindGroupLayout
        ? (pipeline as { getBindGroupLayout: (i: number) => unknown }).getBindGroupLayout(0)
        : undefined,
      entries: [
        { binding: 0, resource: { buffer: normalBuffer } },
        { binding: 1, resource: { buffer: paramBuffer } },
        { binding: 2, resource: { buffer: shadeBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    if (!encoder || typeof encoder.beginComputePass !== "function" || typeof encoder.finish !== "function") return null;
    const pass = encoder.beginComputePass();
    if (!pass || typeof pass.setPipeline !== "function" || typeof pass.dispatchWorkgroups !== "function" || typeof pass.end !== "function") {
      return null;
    }
    pass.setPipeline(pipeline);
    if (typeof pass.setBindGroup === "function") pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    if (typeof encoder.copyBufferToBuffer === "function") {
      encoder.copyBufferToBuffer(shadeBuffer, 0, readBuffer, 0, shadeBytes);
    }
    device.queue.submit([encoder.finish()]);
    if (typeof readBuffer.mapAsync !== "function" || typeof readBuffer.getMappedRange !== "function") return null;
    await readBuffer.mapAsync(MAP_READ_MODE);
    const copy = new Float32Array(readBuffer.getMappedRange().slice(0));
    if (typeof readBuffer.unmap === "function") readBuffer.unmap();
    return Array.from(copy.subarray(0, count));
  } catch {
    return null;
  }
}

function asLight(light: unknown): Vec3 | null {
  if (!light || typeof light !== "object") return null;
  const row = light as { x?: unknown; y?: unknown; z?: unknown };
  const x = Number(row.x);
  const y = Number(row.y);
  const z = Number(row.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function asWalls(walls: unknown): Vec3[] {
  if (!Array.isArray(walls)) return [];
  return walls.map((item) => {
    if (!item || typeof item !== "object") return { x: 0, y: 0, z: 0 };
    const row = item as { x?: unknown; y?: unknown; z?: unknown };
    const x = Number(row.x);
    const y = Number(row.y);
    const z = Number(row.z);
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      z: Number.isFinite(z) ? z : 0,
    };
  });
}

type MetalHost = {
  __riveMetal?: unknown;
  webkit?: { messageHandlers?: { riveShade?: { postMessage?: (msg: unknown) => void } } };
};

type MetalDone = (payload: { backend?: string; shades?: number[] } | null) => void;

function metalPendingMap(): Map<number, MetalDone> {
  const g = globalThis as typeof globalThis & { __riveMetalShadePending?: Map<number, MetalDone> };
  if (!g.__riveMetalShadePending) g.__riveMetalShadePending = new Map();
  return g.__riveMetalShadePending;
}

function nextMetalId(): number {
  const g = globalThis as typeof globalThis & { __riveMetalShadeSeq?: number };
  g.__riveMetalShadeSeq = (g.__riveMetalShadeSeq || 0) + 1;
  return g.__riveMetalShadeSeq;
}

function hostOf(bridge: unknown): MetalHost | null {
  const host = (bridge === undefined ? (typeof globalThis !== "undefined" ? globalThis : null) : bridge) as MetalHost | null;
  if (!host || typeof host !== "object") return null;
  return host;
}

/** True when the native Apple shell exposed a Metal shade handler. Does not invent a GPU. */
export function metalShadeAvailable(bridge?: unknown): boolean {
  const host = hostOf(bridge);
  const handler = host?.webkit?.messageHandlers?.riveShade;
  return !!handler && typeof handler.postMessage === "function";
}

function installMetalResolve(): void {
  const g = globalThis as typeof globalThis & {
    __riveMetalShadeResolve?: (id: number, payload: { backend?: string; shades?: number[] } | null) => void;
  };
  g.__riveMetalShadeResolve = (id, payload) => {
    const pending = metalPendingMap();
    const done = pending.get(Number(id));
    if (!done) return;
    pending.delete(Number(id));
    done(payload);
  };
}

export async function shadeWallsMetal(
  walls: Vec3[],
  light: Vec3,
  bridge?: unknown,
): Promise<number[] | null> {
  const host = hostOf(bridge);
  const handler = host?.webkit?.messageHandlers?.riveShade;
  if (!handler || typeof handler.postMessage !== "function") return null;
  installMetalResolve();
  const id = nextMetalId();
  const normals: number[] = [];
  for (const wall of walls) {
    normals.push(wall.x, wall.y, wall.z);
  }
  return new Promise((resolve) => {
    const pending = metalPendingMap();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, 2000);
    pending.set(id, (payload) => {
      clearTimeout(timer);
      if (!payload || !Array.isArray(payload.shades) || payload.shades.length !== walls.length) {
        resolve(null);
        return;
      }
      const shades = payload.shades.map((n) => Number(n));
      if (shades.some((n) => !Number.isFinite(n))) {
        resolve(null);
        return;
      }
      resolve(shades);
    });
    try {
      handler.postMessage({ id, normals, light: [light.x, light.y, light.z] });
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve(null);
    }
  });
}

/**
 * Shade wall normals locally. On Apple shells, Metal first (more efficient than WebGPU-on-Metal).
 * Else WebGPU. Incomplete GPU → CPU Lambert, no throw.
 */
export async function computeWallShades(
  gpu: GpuLike,
  walls: unknown,
  light: unknown,
  bridge?: unknown,
): Promise<{ backend: "metal" | "webgpu" | "cpu"; shades: number[] }> {
  const list = asWalls(walls);
  const dir = asLight(light);
  const cpu = shadeMany(dir, list);
  if (dir) {
    const metal = await shadeWallsMetal(list, dir, bridge);
    if (metal && metal.length === list.length) return { backend: "metal", shades: metal };
  }
  const device = await acquireGpuDevice(gpu);
  if (!device || !dir) return { backend: "cpu", shades: cpu };
  const gpuShades = await shadeWallsOnDevice(device, list, dir);
  if (!gpuShades || gpuShades.length !== list.length) return { backend: "cpu", shades: cpu };
  return { backend: "webgpu", shades: gpuShades };
}
