import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import type { Atlas } from "./atlas/types";
import { CITY_MEMBERSHIP_M, chipsForCities, cityAfterHereSample, cityForPoint, resolveCityRequest, supportedCityCenters } from "./search";

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
      cityAfterHereSample: typeof cityAfterHereSample;
    };
    const centers = supportedCityCenters();
    assert.equal(shipped.cityForPoint(centers.montreal.lon, centers.montreal.lat, centers), "montreal");
    assert.equal(shipped.cityForPoint(centers.sherbrooke.lon, centers.sherbrooke.lat), "sherbrooke");
    assert.equal(shipped.cityForPoint(centers["trois-rivieres"].lon, centers["trois-rivieres"].lat), "trois-rivieres");
    assert.equal(shipped.cityForPoint(0, 0, centers), null);
    assert.equal(shipped.cityForPoint(-75.7, 45.42), null);
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    assert.match(html, /data-city="quebec"/);
    assert.match(html, /data-city="montreal"/);
    assert.match(html, /data-city="sherbrooke"/);
    assert.match(html, /data-city="trois-rivieres"/);
    assert.match(html, /data-visit="levis"/);
    assert.match(html, /data-visit="laval"/);
    assert.match(html, /data-visit="longueuil"/);
    assert.match(html, /flex-wrap:\s*wrap/);
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /detectCity/);
    assert.match(src, /cityAfterHereSample/);
    assert.match(src, /cityLocked/);
    assert.match(src, /if \(city && city !== state\.city\)/);
    assert.doesNotMatch(src, /let best = state\.city/);
    assert.match(src, /chipsForCities/);
    assert.match(src, /resolveCityRequest/);
  });

  it("keeps an explicit Sherbrooke or Trois-Rivières pick when here is Québec or Montréal", async () => {
    const shipped = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "rive-kit.js")).href)) as {
      cityAfterHereSample: typeof cityAfterHereSample;
    };
    const centers = supportedCityCenters();
    for (const explicit of ["sherbrooke", "trois-rivieres"] as const) {
      for (const detected of ["quebec", "montreal"] as const) {
        const input = { explicitCity: explicit, detectedCity: detected, locked: true };
        assert.equal(cityAfterHereSample(input), explicit);
        assert.equal(shipped.cityAfterHereSample(input), explicit);
        assert.equal(cityForPoint(centers[detected].lon, centers[detected].lat), detected);
      }
    }
    assert.equal(
      cityAfterHereSample({ explicitCity: "quebec", detectedCity: "montreal", locked: false }),
      "montreal",
    );
    assert.equal(
      shipped.cityAfterHereSample({ explicitCity: "quebec", detectedCity: "montreal", locked: false }),
      "montreal",
    );
    assert.equal(cityAfterHereSample({ explicitCity: "quebec", detectedCity: null, locked: false }), "quebec");
    assert.equal(resolveCityRequest("levis").city, "quebec");
    assert.equal(resolveCityRequest("laval").city, "montreal");
  });

  it("loads packed Sherbrooke and Trois-Rivières atlases as their own cities", () => {
    for (const slug of ["sherbrooke", "trois-rivieres"] as const) {
      const atlas = JSON.parse(
        readFileSync(join(process.cwd(), "public", "data", slug, "atlas.json"), "utf8"),
      ) as Atlas;
      assert.equal(atlas.meta.city, slug);
      assert.ok(atlas.routes.length > 0, `${slug} has no routes`);
      assert.ok(atlas.stops.length > 0, `${slug} has no stops`);
    }
  });

  it("inserts Lévis, Laval and Longueuil after their packed parent cities", () => {
    const chips = chipsForCities([
      { city: "quebec", name: "Québec" },
      { city: "montreal", name: "Montréal" },
      { city: "sherbrooke", name: "Sherbrooke" },
      { city: "trois-rivieres", name: "Trois-Rivières" },
    ]);
    const labels = chips.map((chip) => chip.label);
    assert.ok(labels.includes("Québec"));
    assert.ok(labels.includes("Lévis"));
    assert.ok(labels.includes("Montréal"));
    assert.ok(labels.includes("Laval"));
    assert.ok(labels.includes("Longueuil"));
    assert.ok(labels.includes("Sherbrooke"));
    assert.ok(labels.includes("Trois-Rivières"));
    assert.ok(labels.indexOf("Lévis") > labels.indexOf("Québec"));
    assert.ok(labels.indexOf("Lévis") < labels.indexOf("Montréal"));
    assert.equal(resolveCityRequest("levis").city, "quebec");
    assert.equal(resolveCityRequest("laval").visit?.id, "laval");
    assert.equal(resolveCityRequest("longueuil").city, "montreal");
    assert.equal(resolveCityRequest("sherbrooke").city, "sherbrooke");
    assert.equal(resolveCityRequest("sherbrooke").visit, null);
  });

  it("drives the shipped chip helpers for the same visit list", async () => {
    const shipped = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "rive-kit.js")).href)) as {
      chipsForCities: typeof chipsForCities;
      resolveCityRequest: typeof resolveCityRequest;
    };
    const chips = shipped.chipsForCities([{ city: "quebec", name: "Québec" }]);
    assert.ok(chips.some((chip) => chip.id === "levis" && chip.city === "quebec"));
    assert.equal(shipped.resolveCityRequest("longueuil").city, "montreal");
  });
});
