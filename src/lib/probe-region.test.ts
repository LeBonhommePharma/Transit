import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { inServedRegion, servedCenters, validateProbe } from "./probe";

type IndexCity = { city?: string; center?: unknown };

function finiteCenter(center: unknown): [number, number] | null {
  if (!Array.isArray(center) || center.length < 2) return null;
  const lon = Number(center[0]);
  const lat = Number(center[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

describe("probe in-region from shipped city index", () => {
  const index = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "index.json"), "utf8")) as {
    cities?: IndexCity[];
  };
  const cities = Array.isArray(index.cities) ? index.cities : [];

  it("accepts each shipped city center and rejects points far from every center", () => {
    const now = Date.now();
    let checked = 0;
    for (const city of cities) {
      const center = finiteCenter(city.center);
      if (!center) continue;
      checked += 1;
      assert.equal(inServedRegion(center[0], center[1]), true);
      assert.ok(validateProbe({ lon: center[0], lat: center[1], at: now }));
    }
    assert.ok(checked >= 1);
    assert.ok(servedCenters().length >= checked);
    assert.equal(inServedRegion(0, 0), false);
    assert.equal(inServedRegion(-40, 35), false);
    assert.equal(validateProbe({ lon: 0, lat: 0, at: now }), null);
  });

  it("drives shipped rive-kit from the index, not only QC/MTL", async () => {
    const shipped = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "rive-kit.js")).href)) as {
      inServedRegion: typeof inServedRegion;
      setServedCenters: (centers: unknown) => void;
      servedCenters: typeof servedCenters;
      validateProbe: typeof validateProbe;
    };
    const now = Date.now();
    const loaded: Array<{ lon: number; lat: number }> = [];
    for (const city of cities) {
      const center = finiteCenter(city.center);
      if (!center) continue;
      loaded.push({ lon: center[0], lat: center[1] });
      assert.equal(shipped.inServedRegion(center[0], center[1]), true);
      assert.ok(shipped.validateProbe({ lon: center[0], lat: center[1], at: now }));
    }
    assert.ok(loaded.length >= 1);
    shipped.setServedCenters(loaded);
    for (const center of loaded) {
      assert.equal(shipped.inServedRegion(center.lon, center.lat), true);
    }
    assert.equal(shipped.inServedRegion(0, 0), false);
    assert.ok(shipped.servedCenters().length >= loaded.length);

    const kit = readFileSync(join(process.cwd(), "public", "Transit", "rive-kit.js"), "utf8");
    const app = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(kit, /setServedCenters/);
    assert.match(app, /setServedCenters/);
    assert.doesNotMatch(
      kit,
      /haversineMeters\(here, QC\) <= PROBE_CITY_RADIUS_M \|\| haversineMeters\(here, MTL\) <= PROBE_CITY_RADIUS_M/,
    );
  });
});
