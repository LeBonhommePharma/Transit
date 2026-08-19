import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  decodeConditions,
  formatShownLine,
  shouldDrawPrecip,
  shownConditions,
} from "./conditions";
import { weatherFromOpenMeteo } from "./visibility";

const WET = {
  current: {
    temperature_2m: 4,
    precipitation: 1.8,
    rain: 1.8,
    snowfall: 0,
    weather_code: 61,
    wind_speed_10m: 32,
    wind_direction_10m: 40,
    visibility: 4000,
    uv_index: 6.4,
    european_aqi: 78,
  },
  hourly: { precipitation: [1.2, 0.8, 0.4], uv_index: [6, 5, 3], weather_code: [61, 61, 3] },
};

const CLEAR = {
  current: {
    temperature_2m: 18,
    precipitation: 0,
    rain: 0,
    snowfall: 0,
    weather_code: 0,
    wind_speed_10m: 4,
    wind_direction_10m: 180,
    visibility: 16000,
    uv_index: 1.1,
    european_aqi: 22,
  },
  hourly: { precipitation: [0, 0, 0], uv_index: [1, 1, 0], weather_code: [0, 0, 0] },
};

describe("weather decode", () => {
  it("surfaces precip, UV, AQI, wind, and a wet road on a stormy payload", () => {
    const c = decodeConditions(WET);
    assert.ok(c.precipMm != null && c.precipMm > 1);
    assert.ok(c.uv != null && c.uv >= 6);
    assert.ok(c.aqi != null && c.aqi >= 70);
    assert.ok(c.windKmh != null && c.windKmh >= 30);
    assert.ok(c.windDeg != null);
    assert.equal(c.road, "wet");
    const shown = shownConditions(WET);
    assert.ok(shown.precip);
    assert.ok(shown.uv);
    assert.ok(shown.aqi);
    assert.ok(shown.wind);
    assert.equal(shown.road, "mouillée");
    assert.equal(shouldDrawPrecip(WET), true);
    const parsed = weatherFromOpenMeteo(WET);
    assert.ok(parsed);
    const viaFetch = shownConditions(parsed);
    assert.ok(viaFetch.precip, "shownConditions after weatherFromOpenMeteo must keep precip");
    assert.ok(viaFetch.uv);
    assert.ok(viaFetch.aqi);
    assert.ok(viaFetch.wind);
    assert.equal(viaFetch.road, "mouillée");
    assert.equal(shouldDrawPrecip(parsed), true);
    const already = shownConditions(decodeConditions(WET));
    assert.ok(already.precip && already.uv && already.aqi && already.wind);
    const icy = decodeConditions({ current: { temperature_2m: -3, precipitation: 0.4, rain: 0, snowfall: 0.4 } });
    assert.equal(icy.road, "icy");
    assert.equal(shownConditions(icy).road, "glissante");
  });

  it("hides quiet UV, wind, precip, and dry roads on a clear payload", () => {
    const shown = shownConditions(CLEAR);
    assert.equal(shown.precip, undefined);
    assert.equal(shown.uv, undefined);
    assert.equal(shown.aqi, undefined);
    assert.equal(shown.wind, undefined);
    assert.equal(shown.road, undefined);
    assert.equal(shouldDrawPrecip(CLEAR), false);
    assert.equal(decodeConditions(CLEAR).road, "dry");
    assert.equal(formatShownLine(shown), "");
  });

  it("does not invent AQI or UV from junk", () => {
    const empty = decodeConditions(null);
    assert.equal(empty.uv, null);
    assert.equal(empty.aqi, null);
    assert.equal(empty.precipMm, null);
    assert.equal(empty.road, null);
    const junk = decodeConditions({ current: { uv_index: "nope", european_aqi: {}, precipitation: "x" } });
    assert.equal(junk.uv, null);
    assert.equal(junk.aqi, null);
    const vis = weatherFromOpenMeteo({ current: { visibility: 14000, weather_code: 1 } });
    assert.ok(vis);
    const fromVis = decodeConditions(vis);
    assert.equal(fromVis.uv, null);
    assert.equal(fromVis.aqi, null);
  });

  it("drives the shipped static conditions helpers", async () => {
    const shipped = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "conditions.js")).href)) as {
      decodeConditions: typeof decodeConditions;
      shownConditions: typeof shownConditions;
      shouldDrawPrecip: typeof shouldDrawPrecip;
    };
    const shown = shipped.shownConditions(WET);
    assert.ok(shown.precip && shown.wind && shown.road);
    const visJs = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "visibility.js")).href)) as {
      weatherFromOpenMeteo: typeof weatherFromOpenMeteo;
    };
    const parsed = visJs.weatherFromOpenMeteo(WET);
    assert.ok(parsed);
    const via = shipped.shownConditions(parsed);
    assert.ok(via.precip && via.uv && via.aqi && via.wind && via.road);
    assert.equal(shipped.shouldDrawPrecip(CLEAR), false);
    assert.equal(shipped.decodeConditions({}).uv, null);
    const app = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(app, /shouldDrawPrecip/);
    assert.match(app, /function drawPrecip/);
    assert.match(app, /if \(!shouldDrawPrecip\(state\.weather\)\) return/);
    assert.match(app, /paintWx/);
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    assert.match(html, /id="wx"/);
  });
});
