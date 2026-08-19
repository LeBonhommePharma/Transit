import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { daytimeClock, moonlightClock, nightClock } from "./clock";
import { moonAzAlt, moonRiseSet, observerLight, sunAzAlt } from "./celestial";
import {
  lightVectorForMap,
  mapLightDirection,
  mixHex,
  shadeFactor,
  shadeMany,
  screenLightVector,
  wallOutwardNormal,
  worldLightVector,
} from "./shade";

const QC = { lat: 46.8131, lon: -71.2082 };
const MTL = { lat: 45.5017, lon: -73.5673 };

type Hor = { azimuth: number; altitude: number };
type Body = Hor & { source: "sun" | "moon" };
type RiseSet = { rise: Date | null; set: Date | null };
type Vec3 = { x: number; y: number; z: number };

type CelestialApi = {
  sunAzAlt: typeof sunAzAlt;
  moonAzAlt: typeof moonAzAlt;
  moonRiseSet: typeof moonRiseSet;
  observerLight: typeof observerLight;
};

type ShadeApi = {
  mapLightDirection: typeof mapLightDirection;
  worldLightVector: typeof worldLightVector;
  screenLightVector: typeof screenLightVector;
  shadeFactor: typeof shadeFactor;
  shadeMany: typeof shadeMany;
  wallOutwardNormal: typeof wallOutwardNormal;
  mixHex: typeof mixHex;
  lightVectorForMap: typeof lightVectorForMap;
};

async function loadShipped(): Promise<{ celestial: CelestialApi; shade: ShadeApi }> {
  const root = join(process.cwd(), "public", "Transit");
  const celestial = (await import(pathToFileURL(join(root, "celestial.js")).href)) as CelestialApi;
  const shade = (await import(pathToFileURL(join(root, "shade.js")).href)) as ShadeApi;
  return { celestial, shade };
}

function findNightMoon(api: CelestialApi, lat: number, lon: number, from: Date): { time: Date; body: Body } | null {
  for (let t = from.getTime(); t < from.getTime() + 20 * 3600 * 1000; t += 8 * 60 * 1000) {
    const sun = api.sunAzAlt(lat, lon, t);
    const body = api.observerLight(lat, lon, t);
    if (sun && sun.altitude < 0 && body && body.source === "moon") {
      return { time: new Date(t), body };
    }
  }
  return null;
}

function assertHorizontal(row: Hor | null): asserts row is Hor {
  assert.ok(row);
  assert.ok(Number.isFinite(row.azimuth) && row.azimuth >= 0 && row.azimuth < 360);
  assert.ok(Number.isFinite(row.altitude) && row.altitude >= -90 && row.altitude <= 90);
}

describe("celestial sun and moon", () => {
  it("puts the sun above Quebec and Montreal by afternoon and below after local night", () => {
    for (const place of [QC, MTL]) {
      const day = sunAzAlt(place.lat, place.lon, daytimeClock());
      const night = sunAzAlt(place.lat, place.lon, nightClock());
      assertHorizontal(day);
      assertHorizontal(night);
      assert.ok(day.altitude > 0, `afternoon sun should be up at ${place.lat}`);
      assert.ok(night.altitude < 0, `night sun should be down at ${place.lat}`);
    }
  });

  it("lights with the sun by day and the moon at night when the moon is up", () => {
    for (const place of [QC, MTL]) {
      const day = observerLight(place.lat, place.lon, daytimeClock());
      assert.ok(day);
      assert.equal(day.source, "sun");
      assert.ok(day.altitude > 0);
      const sunNight = sunAzAlt(place.lat, place.lon, nightClock());
      assert.ok(sunNight && sunNight.altitude < 0);
      const moonlit = observerLight(place.lat, place.lon, moonlightClock());
      assert.ok(moonlit);
      assert.equal(moonlit.source, "moon");
      assert.ok(moonlit.altitude > 0);
      const nightMoon = findNightMoon({ sunAzAlt, moonAzAlt, moonRiseSet, observerLight }, place.lat, place.lon, daytimeClock());
      assert.ok(nightMoon, "moon should be above the horizon at some night instant");
      assert.equal(nightMoon.body.source, "moon");
      assert.ok(nightMoon.body.altitude > 0);
    }
  });

  it("keeps moon altitude near the horizon at rise and set and higher while the moon is up", () => {
    for (const place of [QC, MTL]) {
      const rs = moonRiseSet(place.lat, place.lon, daytimeClock());
      assert.ok(rs);
      assert.ok(rs.rise instanceof Date);
      assert.ok(rs.set instanceof Date);
      const atRise = moonAzAlt(place.lat, place.lon, rs.rise as Date);
      const atSet = moonAzAlt(place.lat, place.lon, rs.set as Date);
      assertHorizontal(atRise);
      assertHorizontal(atSet);
      assert.ok(Math.abs(atRise.altitude) < 1.5, `rise alt ${atRise.altitude}`);
      assert.ok(Math.abs(atSet.altitude) < 1.5, `set alt ${atSet.altitude}`);
      const mid = new Date(((rs.rise as Date).getTime() + (rs.set as Date).getTime()) / 2);
      const atMid = moonAzAlt(place.lat, place.lon, mid);
      assertHorizontal(atMid);
      assert.ok(atMid.altitude > Math.max(atRise.altitude, atSet.altitude) + 2);
    }
  });

  it("refuses junk lat/lon/time instead of inventing a body", () => {
    const t = daytimeClock();
    assert.equal(sunAzAlt(Number.NaN, QC.lon, t), null);
    assert.equal(sunAzAlt(QC.lat, 200, t), null);
    assert.equal(moonAzAlt(QC.lat, QC.lon, "nope"), null);
    assert.equal(observerLight(undefined, QC.lon, t), null);
    assert.equal(observerLight(QC.lat, QC.lon, {}), null);
    assert.equal(moonRiseSet(91, QC.lon, t), null);
    assert.equal(moonRiseSet(QC.lat, QC.lon, ""), null);
  });

  it("drives the shipped static celestial module on the same Quebec clock", async () => {
    const { celestial } = await loadShipped();
    const day = celestial.sunAzAlt(QC.lat, QC.lon, daytimeClock());
    const src = celestial.observerLight(QC.lat, QC.lon, daytimeClock());
    assertHorizontal(day);
    assert.ok(day.altitude > 0);
    assert.ok(src);
    assert.equal(src.source, "sun");
    assert.equal(celestial.observerLight(QC.lat, Number.NaN, daytimeClock()), null);
    const rs = celestial.moonRiseSet(QC.lat, QC.lon, daytimeClock());
    assert.ok(rs && rs.rise && rs.set);
    const atRise = celestial.moonAzAlt(QC.lat, QC.lon, rs.rise);
    assertHorizontal(atRise);
    assert.ok(Math.abs(atRise.altitude) < 1.5);
  });
});

describe("map shade from heading and face", () => {
  it("reverses screen-space light x when heading flips 180°", () => {
    const east0 = mapLightDirection(90, 45, 0);
    const east180 = mapLightDirection(90, 45, 180);
    assert.ok(east0 && east180);
    assert.ok(east0.x > 0.4);
    assert.ok(east180.x < -0.4);
    const body = observerLight(QC.lat, QC.lon, daytimeClock());
    assert.ok(body);
    const a = mapLightDirection(body.azimuth, body.altitude, 0);
    const b = mapLightDirection(body.azimuth, body.altitude, 180);
    assert.ok(a && b);
    assert.ok(Math.abs(a.x - b.x) > 0.05 || Math.abs(a.x) < 0.08);
    if (Math.abs(a.x) > 0.08) assert.ok(Math.sign(a.x) !== Math.sign(b.x));
  });

  it("does not invent a map direction from junk heading", () => {
    assert.equal(mapLightDirection(90, 45, null), null);
    assert.equal(mapLightDirection(90, 45, undefined), null);
    assert.equal(mapLightDirection(90, 45, Number.NaN), null);
    assert.equal(mapLightDirection(90, 45, -1), null);
    assert.equal(mapLightDirection(Number.NaN, 45, 0), null);
    assert.ok(worldLightVector(90, 45));
    assert.ok(screenLightVector(90, 45));
    assert.ok(lightVectorForMap(90, 45, null));
    assert.ok(mapLightDirection(90, 45, 0));
  });

  it("makes a face toward the light brighter than the opposite face", () => {
    const light = { x: 1, y: 0, z: 0 };
    const toward = shadeFactor(light, { x: 1, y: 0, z: 0 });
    const away = shadeFactor(light, { x: -1, y: 0, z: 0 });
    assert.ok(toward > away + 0.3);
    assert.ok(toward > 0.7);
    assert.ok(away < 0.35);
    const shades = shadeMany(light, [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
    ]);
    assert.ok(shades[0] > shades[1]);
    const n = wallOutwardNormal([0, 0], [0, 10], 5, 5);
    assert.ok(n);
    const facing = shadeFactor({ x: n.x, y: n.y, z: 0 }, n);
    const back = shadeFactor({ x: -n.x, y: -n.y, z: 0 }, n);
    assert.ok(facing > back);
    assert.equal(mixHex("#000000", "#ffffff", 0.5).toLowerCase(), "#808080");
  });

  it("drives the shipped static shade helpers", async () => {
    const { shade } = await loadShipped();
    const a = shade.mapLightDirection(90, 40, 0);
    const b = shade.mapLightDirection(90, 40, 180);
    assert.ok(a && b);
    assert.ok(a.x > 0);
    assert.ok(b.x < 0);
    assert.equal(shade.mapLightDirection(90, 40, null), null);
    const toward = shade.shadeFactor({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 });
    const away = shade.shadeFactor({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 });
    assert.ok(toward > away);
  });

  it("uses computed light in drawBuildings instead of the screen-x wall heuristic", () => {
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /from "\.\/celestial\.js"/);
    assert.match(src, /from "\.\/shade\.js"/);
    assert.match(src, /observerLight/);
    assert.match(src, /lightVectorForMap/);
    assert.match(src, /shadeFactor|shadeMany/);
    assert.match(src, /computeWallShades/);
    assert.doesNotMatch(src, /ground\[i \+ 1\]\[0\] >= ground\[i\]\[0\]/);
    assert.match(src, /const shades = light \? shadeMany\(light, normals\)/);
    assert.doesNotMatch(src, /shades = gpuLightState\.shades/);
    assert.match(src, /cam\.lon/);
    assert.match(src, /cam\.lat/);
    assert.match(src, /cam\.zoom/);
    assert.match(src, /cam\.pitch/);
  });
});
