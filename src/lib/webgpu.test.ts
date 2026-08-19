import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { acquireGpuDevice, computeWallShades, metalShadeAvailable, probeGpuLabel, shadeWallsMetal } from "./webgpu";
import { shadeFactor, shadeMany } from "./shade";

describe("WebGPU probe", () => {
  it("labels Canvas 2D when gpu or requestAdapter is missing", async () => {
    assert.equal(await probeGpuLabel(undefined), "Canvas 2D");
    assert.equal(await probeGpuLabel(null), "Canvas 2D");
    assert.equal(await probeGpuLabel({}), "Canvas 2D");
  });

  it("requests an adapter and labels WebGPU prêt when one exists", async () => {
    const calls: number[] = [];
    const gpu = {
      requestAdapter: async () => {
        calls.push(1);
        return { name: "fake" };
      },
    };
    assert.equal(await probeGpuLabel(gpu), "WebGPU prêt");
    assert.equal(calls.length, 1);
  });

  it("stays on Canvas 2D when the adapter request returns nothing or throws", async () => {
    assert.equal(await probeGpuLabel({ requestAdapter: async () => null }), "Canvas 2D");
    assert.equal(
      await probeGpuLabel({
        requestAdapter: async () => {
          throw new Error("no gpu");
        },
      }),
      "Canvas 2D",
    );
  });

  it("drives the shipped static probe and the live tryWebGPU hook", async () => {
    const jsPath = join(process.cwd(), "public", "Transit", "webgpu.js");
    const { probeGpuLabel: shipped } = (await import(pathToFileURL(jsPath).href)) as {
      probeGpuLabel: typeof probeGpuLabel;
    };
    assert.equal(await shipped(undefined), "Canvas 2D");
    assert.equal(await shipped({ requestAdapter: async () => ({}) }), "WebGPU prêt");
    const app = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(app, /from "\.\/webgpu\.js"/);
    assert.match(app, /probeGpuLabel/);
    assert.match(app, /computeWallShades/);
    assert.match(app, /acquireGpuDevice/);
    assert.match(app, /tryWebGPU/);
  });
});

describe("WebGPU wall lighting", () => {
  const walls = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
  ];
  const light = { x: 1, y: 0, z: 0 };

  it("degrades to CPU shade without throwing when GPU is missing", async () => {
    const missing = await computeWallShades(undefined, walls, light);
    assert.equal(missing.backend, "cpu");
    assert.equal(missing.shades.length, 2);
    assert.ok(missing.shades[0] > missing.shades[1]);
    assert.equal(missing.shades[0], shadeFactor(light, walls[0]));
    const empty = await computeWallShades(null, walls, light);
    assert.equal(empty.backend, "cpu");
    const blank = await computeWallShades({}, walls, light);
    assert.equal(blank.backend, "cpu");
  });

  it("attempts a local adapter/device path when requestAdapter exists", async () => {
    const calls = { adapter: 0, device: 0 };
    const gpu = {
      requestAdapter: async () => {
        calls.adapter += 1;
        return {
          requestDevice: async () => {
            calls.device += 1;
            return {};
          },
        };
      },
    };
    const row = await computeWallShades(gpu, walls, light);
    assert.equal(calls.adapter, 1);
    assert.equal(calls.device, 1);
    assert.equal(row.backend, "cpu");
    assert.ok(row.shades[0] > row.shades[1]);
    const thrown = await computeWallShades(
      {
        requestAdapter: async () => {
          throw new Error("no adapter");
        },
      },
      walls,
      light,
    );
    assert.equal(thrown.backend, "cpu");
    assert.equal(thrown.shades.length, 2);
  });

  it("drives the shipped static lighting entry", async () => {
    const jsPath = join(process.cwd(), "public", "Transit", "webgpu.js");
    const shipped = (await import(pathToFileURL(jsPath).href)) as {
      computeWallShades: typeof computeWallShades;
      acquireGpuDevice: typeof acquireGpuDevice;
    };
    const none = await shipped.computeWallShades(undefined, walls, light);
    assert.equal(none.backend, "cpu");
    assert.ok(none.shades[0] > none.shades[1]);
    let adapters = 0;
    const gpu = {
      requestAdapter: async () => {
        adapters += 1;
        return { requestDevice: async () => ({}) };
      },
    };
    const tried = await shipped.computeWallShades(gpu, walls, light);
    assert.equal(adapters, 1);
    assert.equal(tried.backend, "cpu");
    assert.equal(await shipped.acquireGpuDevice(undefined), null);
    const src = readFileSync(jsPath, "utf8");
    assert.match(src, /@compute/);
    assert.match(src, /createComputePipeline/);
    const app = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(app, /computeWallShades/);
    assert.match(app, /metalShadeAvailable/);
    assert.doesNotMatch(app, /ground\[i \+ 1\]\[0\] >= ground\[i\]\[0\]/);
  });

  it("prefers a Metal bridge over WebGPU and skips requestAdapter", async () => {
    assert.equal(metalShadeAvailable(undefined), false);
    assert.equal(metalShadeAvailable({}), false);
    let adapters = 0;
    const gpu = {
      requestAdapter: async () => {
        adapters += 1;
        return { requestDevice: async () => ({}) };
      },
    };
    const bridge = {
      webkit: {
        messageHandlers: {
          riveShade: {
            postMessage(msg: { id: number; normals: number[]; light: number[] }) {
              const g = globalThis as typeof globalThis & {
                __riveMetalShadeResolve?: (id: number, payload: { backend: string; shades: number[] }) => void;
              };
              queueMicrotask(() => {
                g.__riveMetalShadeResolve?.(msg.id, { backend: "metal", shades: [0.95, 0.22] });
              });
            },
          },
        },
      },
    };
    assert.equal(metalShadeAvailable(bridge), true);
    const row = await computeWallShades(gpu, walls, light, bridge);
    assert.equal(row.backend, "metal");
    assert.equal(row.shades.length, 2);
    assert.ok(row.shades[0] > row.shades[1]);
    assert.equal(adapters, 0);
    const shipped = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "webgpu.js")).href)) as {
      computeWallShades: typeof computeWallShades;
      metalShadeAvailable: typeof metalShadeAvailable;
    };
    assert.equal(shipped.metalShadeAvailable(bridge), true);
    const viaShip = await shipped.computeWallShades(undefined, walls, light, bridge);
    assert.equal(viaShip.backend, "metal");
    const src = readFileSync(join(process.cwd(), "public", "Transit", "webgpu.js"), "utf8");
    assert.match(src, /riveShade/);
    assert.match(src, /backend: "metal"/);
    const app = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(app, /probeGpuLabel/);
    assert.match(app, /metalShadeAvailable/);
    assert.doesNotMatch(app, /textContent = "Metal/);
  });

  it("calls riveShade.postMessage on the handler so WKWebView Metal can run", async () => {
    const handler = {
      token: "riveShade",
      postMessage(msg: { id: number; normals: number[]; light: number[] }) {
        if (this !== handler || this.token !== "riveShade") throw new Error("unbound postMessage");
        const packed = [];
        for (let i = 0; i + 2 < msg.normals.length; i += 3) {
          packed.push({ x: msg.normals[i], y: msg.normals[i + 1], z: msg.normals[i + 2] });
        }
        const dir = { x: msg.light[0], y: msg.light[1], z: msg.light[2] };
        const g = globalThis as typeof globalThis & {
          __riveMetalShadeResolve?: (id: number, payload: { backend: string; shades: number[] }) => void;
        };
        queueMicrotask(() => {
          g.__riveMetalShadeResolve?.(msg.id, { backend: "metal", shades: shadeMany(dir, packed) });
        });
      },
    };
    const bridge = { webkit: { messageHandlers: { riveShade: handler } } };
    const towardAway = await shadeWallsMetal(walls, light, bridge);
    assert.ok(towardAway);
    assert.equal(towardAway.length, 2);
    assert.ok(towardAway[0] > towardAway[1]);
    assert.equal(towardAway[0], shadeFactor(light, walls[0]));
    const jsPath = join(process.cwd(), "public", "Transit", "webgpu.js");
    const shipped = (await import(pathToFileURL(jsPath).href)) as {
      shadeWallsMetal: typeof shadeWallsMetal;
      computeWallShades: typeof computeWallShades;
    };
    const shippedRow = await shipped.shadeWallsMetal(walls, light, bridge);
    assert.ok(shippedRow);
    assert.ok(shippedRow[0] > shippedRow[1]);
    const viaCompute = await shipped.computeWallShades(undefined, walls, light, bridge);
    assert.equal(viaCompute.backend, "metal");
    assert.ok(viaCompute.shades[0] > viaCompute.shades[1]);
    const src = readFileSync(jsPath, "utf8");
    assert.match(src, /handler\.postMessage\(/);
    assert.doesNotMatch(src, /const post =[\s\S]{0,160}post\(/);
  });
});
