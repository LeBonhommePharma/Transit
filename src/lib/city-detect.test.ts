import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { CITY_MEMBERSHIP_M, cityForPoint, supportedCityCenters } from "./search";

describe("city auto-detect", () => {
  it("maps a point near a supported center and refuses far or junk points", () => {
    const centers = supportedCityCenters();
    assert.ok(centers.quebec && centers.montreal);
    assert.equal(cityForPoint(centers.quebec.lon, centers.quebec.lat), "quebec");
    assert.equal(cityForPoint(centers.montreal.lon, centers.montreal.lat), "montreal");
    assert.equal(cityForPoint(centers.quebec.lon + 0.02, centers.quebec.lat + 0.02), "quebec");
    assert.equal(cityForPoint(0, 0), null);
    assert.equal(cityForPoint(-40, 40), null);
    assert.equal(cityForPoint(Number.NaN, centers.quebec.lat), null);
    assert.equal(cityForPoint(centers.quebec.lon, 91), null);
    assert.equal(cityForPoint(undefined, undefined), null);
    const farLon = centers.quebec.lon + 5;
    assert.ok(CITY_MEMBERSHIP_M < 200_000);
    assert.equal(cityForPoint(farLon, centers.quebec.lat), null);
  });

  it("drives the shipped static detector and keeps visit-another-city chips", async () => {
    const shipped = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "rive-kit.js")).href)) as {
      cityForPoint: typeof cityForPoint;
    };
    const centers = supportedCityCenters();
    assert.equal(shipped.cityForPoint(centers.montreal.lon, centers.montreal.lat, centers), "montreal");
    assert.equal(shipped.cityForPoint(centers.sherbrooke.lon, centers.sherbrooke.lat), "sherbrooke");
    assert.equal(shipped.cityForPoint(0, 0, centers), null);
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    assert.match(html, /data-city="quebec"/);
    assert.match(html, /data-city="montreal"/);
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /detectCity/);
    assert.match(src, /if \(city && city !== state\.city\)/);
    assert.doesNotMatch(src, /let best = state\.city/);
  });
});
