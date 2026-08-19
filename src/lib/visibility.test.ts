import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { MOTION_CORE_CAP, MOTION_FAR_CAP, MOTION_MID_CAP, overpassMotionQuery } from "./buildings";
import {
  DEFAULT_VISIBILITY_M,
  bboxSpanMeters,
  continueExtentMeters,
  loadExtentMeters,
  motionBuildingQueryAllowed,
  motionViewBbox,
  visibilityMetersFromWeather,
  weatherFromOpenMeteo,
} from "./visibility";

const QC = { lat: 46.8131, lon: -71.2082 };

type VisApi = {
  visibilityMetersFromWeather: typeof visibilityMetersFromWeather;
  loadExtentMeters: typeof loadExtentMeters;
  continueExtentMeters: typeof continueExtentMeters;
  motionViewBbox: typeof motionViewBbox;
  motionBuildingQueryAllowed: typeof motionBuildingQueryAllowed;
  bboxSpanMeters: typeof bboxSpanMeters;
  weatherFromOpenMeteo: typeof weatherFromOpenMeteo;
};

async function loadShipped(): Promise<VisApi> {
  return (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "visibility.js")).href)) as VisApi;
}

describe("visibility load extents", () => {
  it("sizes a clear working set to km-scale vis and a fog set distinctly smaller", () => {
    const clear = visibilityMetersFromWeather({ visibilityM: 12_000, condition: "clear" });
    const fog = visibilityMetersFromWeather({ visibilityM: 400, condition: "fog" });
    assert.ok(clear > 8_000 && clear < 20_000);
    assert.ok(fog < 1_000);
    assert.ok(fog < clear / 4);
    const clearLoad = loadExtentMeters(clear);
    const fogLoad = loadExtentMeters(fog);
    assert.ok(clearLoad >= clear && clearLoad < clear * 1.3);
    assert.ok(fogLoad < clearLoad / 4);
    const clearCont = continueExtentMeters(clear);
    const fogCont = continueExtentMeters(fog);
    assert.ok(clearCont > clear);
    assert.ok(fogCont > fog);
    assert.ok(clearCont > clearLoad);
  });

  it("continues details past visibility and never clips at equality", () => {
    for (const vis of [400, 2_500, 8_000, 16_000]) {
      const cont = continueExtentMeters(vis);
      assert.ok(cont > vis, `continue ${cont} must exceed vis ${vis}`);
      assert.ok(cont > loadExtentMeters(vis));
    }
  });

  it("uses a finite conservative default on junk weather, not a fabricated METAR", () => {
    for (const junk of [undefined, null, {}, { visibilityM: "nope" }, { visibilityM: Number.NaN }, { condition: "" }]) {
      const vis = visibilityMetersFromWeather(junk);
      assert.ok(Number.isFinite(vis) && vis > 0);
      assert.equal(vis, DEFAULT_VISIBILITY_M);
    }
    assert.ok(Number.isFinite(loadExtentMeters(Number.NaN)));
    assert.ok(Number.isFinite(continueExtentMeters("x")));
    assert.equal(motionViewBbox({ lat: 200, lon: 0 }, { visibilityM: 10_000 }), null);
  });

  it("drives the shipped static visibility helpers on the same fixtures", async () => {
    const shipped = await loadShipped();
    const clear = shipped.visibilityMetersFromWeather({ visibilityKm: 16, condition: "clear" });
    const fog = shipped.visibilityMetersFromWeather({ condition: "fog" });
    assert.ok(clear > 10_000);
    assert.ok(fog < 1_000);
    assert.ok(shipped.continueExtentMeters(clear) > clear);
    assert.equal(shipped.visibilityMetersFromWeather(null), DEFAULT_VISIBILITY_M);
    const decoded = shipped.weatherFromOpenMeteo({
      current: { visibility: 14_000, weather_code: 1 },
      hourly: { visibility: [14_000, 13_000], weather_code: [1, 2] },
    });
    assert.ok(decoded);
    assert.equal(visibilityMetersFromWeather(decoded), visibilityMetersFromWeather({ visibilityM: 14_000 }));
  });
});

describe("motion-view working set", () => {
  it("uses a visibility-scaled bbox, not the old zoom-only hundreds-of-meters rectangle", () => {
    const pack = motionViewBbox(QC, { visibilityM: 10_000 });
    assert.ok(pack);
    const span = bboxSpanMeters(pack.outer, QC.lat);
    assert.ok(span.northSouth > 18_000, `outer NS ${span.northSouth}`);
    assert.ok(span.westEast > 18_000);
    const inner = bboxSpanMeters(pack.inner, QC.lat);
    assert.ok(inner.northSouth > 10_000);
    const zoom15deg = 360 / 2 ** 15;
    const zoomOnlyNS = 0.64 * zoom15deg * 111_320;
    assert.ok(zoomOnlyNS < 1_200);
    assert.ok(span.northSouth > zoomOnlyNS * 8);
    const fog = motionViewBbox(QC, { condition: "fog", visibilityM: 400 });
    assert.ok(fog);
    const fogSpan = bboxSpanMeters(fog.outer, QC.lat);
    assert.ok(fogSpan.northSouth < span.northSouth / 3);
  });

  it("keeps GPS-follow neighborhood details and covers vis with the motion query", () => {
    const gps = { lon: QC.lon, lat: QC.lat, source: "gps" };
    const cam = { lon: QC.lon, lat: QC.lat };
    assert.equal(motionBuildingQueryAllowed(gps, cam), true);
    assert.equal(motionBuildingQueryAllowed(null, cam), true);
    const pack = motionViewBbox(QC, { visibilityM: 8_000 });
    assert.ok(pack);
    const q = overpassMotionQuery(QC, pack.extents.loadM, pack.extents.continueM);
    assert.match(q, /around:/);
    assert.match(q, new RegExp(`out tags geom ${MOTION_CORE_CAP}`));
    assert.match(q, new RegExp(`out tags geom ${MOTION_MID_CAP}`));
    assert.match(q, new RegExp(`out tags geom ${MOTION_FAR_CAP}`));
    const outs = q.match(/out tags geom \d+/g) || [];
    assert.ok(outs.length >= 3);
    assert.doesNotMatch(q, /out tags geom 800/);
    assert.match(q, new RegExp(`around:${Math.round(pack.extents.loadM)},`));
    assert.match(q, new RegExp(`around:${Math.round(pack.extents.continueM)},`));
    assert.equal(overpassMotionQuery({ lat: Number.NaN, lon: QC.lon }, 1000, 2000), "");
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /motionViewBbox/);
    assert.match(src, /overpassMotionQuery\(center, pack\.extents\.loadM, pack\.extents\.continueM\)/);
    assert.match(src, /motionBuildingQueryAllowed/);
    assert.doesNotMatch(src, /haversineMeters\(state\.camera, state\.here\) > 1500/);
    assert.doesNotMatch(src, /360 \/ 2 \*\* state\.camera\.zoom/);
    assert.match(src, /function drawBuildings/);
    assert.doesNotMatch(src, /clip.*visibility|visibilityM && haversine/);
  });

  it("drives the shipped Overpass motion query with split around: budgets", async () => {
    const js = join(process.cwd(), "public", "Transit", "buildings.js");
    const shipped = (await import(pathToFileURL(js).href)) as {
      overpassMotionQuery: typeof overpassMotionQuery;
    };
    const pack = motionViewBbox(QC, { visibilityM: 10_000 });
    assert.ok(pack);
    const q = shipped.overpassMotionQuery(QC, pack.extents.loadM, pack.extents.continueM);
    assert.match(q, /around:/);
    const outs = q.match(/out tags geom \d+/g) || [];
    assert.ok(outs.length >= 3);
    assert.notEqual(outs[0], outs[outs.length - 1]);
    assert.doesNotMatch(q, /\(.*way\["building"\].*\);out tags geom 800/);
  });
});
