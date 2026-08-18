import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { probeGpuLabel } from "./webgpu";

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
    assert.match(app, /tryWebGPU/);
  });
});
